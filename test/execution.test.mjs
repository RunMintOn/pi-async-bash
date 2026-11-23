import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { TaskManager } from "../src/tasks.ts";

const exited = (exit_code) => ({ structuredContent: { exit_code } });

test("foreground exit returns the native result instead of a task", async () => {
  const tasks = new TaskManager(20);
  try {
    const native = exited(7);
    assert.equal(await tasks.execute("owner", undefined, async ({ start }) => {
      start();
      return native;
    }), native);
    assert.deepEqual(tasks.takeCompletions("owner"), []);
  } finally { await tasks.shutdown(); }
});

test("wait expiry and cancellation leave completion pending for the owner", async () => {
  const tasks = new TaskManager(10);
  const gate = Promise.withResolvers();
  try {
    const first = await tasks.execute("owner", undefined, async ({ start, log, exited: recordExit }) => {
      start();
      log(Buffer.from("early\n"));
      await gate.promise;
      log(Buffer.from("late"));
      recordExit(9);
      return exited(9);
    });
    assert.deepEqual(Object.keys(first).sort(), ["log_path", "status", "task_id"]);
    assert.equal(readFileSync(first.log_path, "utf8"), "early\n");
    const live = await tasks.wait("owner", first.task_id, 0.01);
    assert.equal(live.status, "running");
    assert.equal(live.output_tail, "early\n");
    const controller = new AbortController();
    const wait = tasks.wait("owner", first.task_id, 30, controller.signal);
    controller.abort();
    await assert.rejects(wait, { name: "AbortError" });
    const finished = Promise.withResolvers();
    const off = tasks.subscribe(finished.resolve);
    gate.resolve();
    await finished.promise;
    off();
    assert.deepEqual(tasks.takeCompletions("elsewhere"), []);
    const [final] = tasks.takeCompletions("owner");
    assert.equal(final.status, "exited");
    assert.equal(final.exit_code, 9);
    assert.equal(final.output_tail, "early\nlate");
    assert.deepEqual(tasks.takeCompletions("owner"), []);
    assert.deepEqual(await tasks.wait("owner", first.task_id, 30), final);
    await tasks.shutdown();
    assert(!existsSync(first.log_path));
  } finally {
    gate.resolve();
    await tasks.shutdown();
  }
});

test("only an acknowledged result consumes the automatic delivery", async () => {
  const tasks = new TaskManager(10);
  const gate = Promise.withResolvers();
  try {
    const first = await tasks.execute("owner", undefined, async ({ start, exited: recordExit }) => {
      start();
      await gate.promise;
      recordExit(0);
      return exited(0);
    });
    const waiting = tasks.wait("owner", first.task_id, 30);
    gate.resolve();
    assert.equal((await waiting).exit_code, 0);
    tasks.markDelivered("owner", first.task_id);
    assert.deepEqual(tasks.takeCompletions("owner"), []);
  } finally {
    gate.resolve();
    await tasks.shutdown();
  }
});
