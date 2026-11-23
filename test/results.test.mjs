import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { TaskManager } from "../src/tasks.ts";

async function preview(output) {
  const tasks = new TaskManager(5);
  const gate = Promise.withResolvers();
  try {
    const ref = await tasks.execute("owner", undefined, async ({ start, log, exited }) => {
      start();
      await gate.promise;
      log(Buffer.from(output));
      exited(0);
    });
    gate.resolve();
    const final = await tasks.wait("owner", ref.task_id, 1);
    assert.equal(fs.readFileSync(ref.log_path, "utf8"), output);
    return final;
  } finally { await tasks.shutdown(); }
}

test("preview reports original line numbers, including a final line without a newline", async () => {
  const output = Array.from({ length: 42 }, (_, i) => `line ${i + 1}\n`).join("") + "last line";
  const data = await preview(output);
  assert.equal(data.output_tail, output.split("\n").slice(3).join("\n"));
  assert.equal(data.start_line, 4);
  assert.equal(data.end_line, 43);
  assert.equal(data.truncated, true);
});

test("the byte limit keeps whole lines if possible and keeps a UTF-8 suffix of an oversized last line", async () => {
  const whole = await preview("x".repeat(4095) + "\n" + "last\n");
  assert.equal(whole.output_tail, "last\n");
  assert.equal(whole.start_line, 2);
  assert.equal(whole.end_line, 2);
  assert.equal(whole.truncated, true);
  assert.equal(whole.partial_line, undefined);
  const partial = await preview("heading\n" + "中".repeat(2000));
  assert.equal(partial.output_tail, "中".repeat(1365));
  assert.equal(partial.start_line, 2);
  assert.equal(partial.end_line, 2);
  assert.equal(partial.partial_line, true);
  assert.equal(partial.truncated, true);
});

test("empty and exact-limit logs have no truncation", async () => {
  const empty = await preview("");
  assert.equal(empty.output_tail, "");
  assert.equal(empty.start_line, undefined);
  assert.equal(empty.truncated, false);
  const output = "a".repeat(4095) + "\n";
  const exact = await preview(output);
  assert.equal(exact.output_tail, output);
  assert.equal(exact.start_line, 1);
  assert.equal(exact.end_line, 1);
  assert.equal(exact.truncated, false);
});

test("a log write failure is delivered as a failed task with an incomplete log", async t => {
  const tasks = new TaskManager(5);
  const gate = Promise.withResolvers();
  const createStream = fs.createWriteStream;
  t.mock.method(fs, "createWriteStream", (path, options) => createStream(path, {
    ...options,
    fs: {
      close: fs.close,
      write(fd, data, offset, length, position, cb) {
        if (data.toString() === "cannot write") return queueMicrotask(() => cb(new Error("disk full")));
        return fs.write(fd, data, offset, length, position, cb);
      },
    },
  }));
  syncBuiltinESMExports();
  try {
    const ref = await tasks.execute("owner", undefined, async ({ start, log }) => {
      start();
      log(Buffer.from("early\n"));
      await gate.promise;
      log(Buffer.from("cannot write"));
    });
    gate.resolve();
    const result = await tasks.wait("owner", ref.task_id, 1);
    assert.equal(result.status, "failed");
    assert.match(result.log_error, /disk full/);
    assert.equal(result.output_tail, "early\n");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    gate.resolve();
    await tasks.shutdown();
  }
});
