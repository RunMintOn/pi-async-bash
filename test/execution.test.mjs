import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { assertProcessResult, harness, node, quote } from "./support.mjs";

test("a long command yields a reference and waiting returns only new output and its exit code", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const first = await h.call("start", {
      command: "printf 'early\\n'; sleep 1; printf 'late\\n'; exit 7",
      yield_time_ms: 250,
    });
    assert.equal(typeof first.details.session_id, "number");
    assert.equal(first.details.output, "early\n");
    assert.equal(first.details.exit_code, undefined);

    const started = performance.now();
    const final = await h.call("wait", { session_id: first.details.session_id, yield_time_ms: 300000 }, "write_stdin");
    assert(performance.now() - started < 4000, "completion should not wait out the requested window");
    assertProcessResult(final.details, { output: "late\n", exit_code: 7 });
    assert.equal(final.isError, true);
    const again = await h.call("read completed", { session_id: first.details.session_id }, "write_stdin");
    assertProcessResult(again.details, { output: "", exit_code: 7 });
    assert(again.details.wall_time_seconds < 0.5, "completed reads report call time, not process lifetime");
  } finally { await h.close(); }
});

test("the default initial wait is ten seconds and never restarts the command", { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    const command = node(`
      process.stdout.write("DEFAULT_READY\\n");
      setTimeout(() => { process.stdout.write("DEFAULT_DONE\\n"); process.exit(0); }, 11000);
    `);
    const started = performance.now();
    const first = await h.call("default wait", { command });
    const elapsed = performance.now() - started;
    assert(elapsed >= 9700 && elapsed < 13000, `initial wait took ${elapsed} ms`);
    assert(first.details.wall_time_seconds >= 9.7 && first.details.wall_time_seconds < 13);
    assert.equal(first.details.output, "DEFAULT_READY\n");
    assert.equal(typeof first.details.session_id, "number");
    const final = await h.call("finish default", { session_id: first.details.session_id }, "write_stdin");
    assertProcessResult(final.details, { output: "DEFAULT_DONE\n", exit_code: 0 });
    assert(final.details.wall_time_seconds < 4, "later waits must not include the initial ten-second wait");
  } finally { await h.close(); }
});

test("an empty wait expires without stopping the command and completion returns early on the next wait", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const gate = join(h.dir, "finish");
    const first = await h.call("start gated", {
      command: `printf READY; while [ ! -f ${quote(gate)} ]; do sleep 0.02; done; printf DONE`,
      yield_time_ms: 250,
    });
    const started = performance.now();
    const waiting = await h.call("window expires", {
      session_id: first.details.session_id, yield_time_ms: 0,
    }, "write_stdin");
    assert(performance.now() - started >= 4800, "empty polls have a five-second minimum window");
    assertProcessResult(waiting.details, { output: "", session_id: first.details.session_id });
    writeFileSync(gate, "");
    const final = await h.call("finish gated", { session_id: first.details.session_id }, "write_stdin");
    assertProcessResult(final.details, { output: "DONE", exit_code: 0 });
  } finally { await h.close(); }
});

test("waiting on one session does not block an independent command in the same tool batch", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const gate = join(h.dir, "independent-finish");
    const first = await h.call("dependent process", {
      command: `printf READY; while [ ! -f ${quote(gate)} ]; do sleep 0.02; done; printf DONE`,
      yield_time_ms: 250,
    });
    h.commands.set("independent batch", [
      { name: "write_stdin", args: { session_id: first.details.session_id } },
      { name: "bash", args: { command: `touch ${quote(gate)}; printf INDEPENDENT` } },
    ]);
    const before = h.runtime.session.messages.length;
    await h.runtime.session.prompt("independent batch");
    const results = h.runtime.session.messages.slice(before).filter(message => message.role === "toolResult");
    assertProcessResult(results.find(message => message.toolName === "write_stdin").details, { output: "DONE", exit_code: 0 });
    assertProcessResult(results.find(message => message.toolName === "bash").details, { output: "INDEPENDENT", exit_code: 0 });
  } finally { await h.close(); }
});

test("pipe input resumes the same process without replaying its first output", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const first = await h.call("read pipe", {
      command: node(`process.stdout.write("PIPE_READY\\n"); process.stdin.once("data", data => { process.stdout.write("ANSWER:" + data); process.exit(0); });`),
      yield_time_ms: 250,
    });
    assert.equal(first.details.output, "PIPE_READY\n");
    const final = await h.call("answer pipe", { session_id: first.details.session_id, chars: "hello\n" }, "write_stdin");
    assertProcessResult(final.details, { output: "ANSWER:hello\n", exit_code: 0 });
  } finally { await h.close(); }
});

test("pipe backpressure respects the wait window and preserves input order across yields", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const gate = join(h.dir, "read-stdin");
    const first = await h.call("defer reading input", {
      command: "exec " + node(`
        const fs = require("node:fs");
        const deadline = setTimeout(() => process.exit(9), 4000);
        const poll = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(gate)})) return;
          clearInterval(poll);
          clearTimeout(deadline);
          const chunks = [];
          let size = 0;
          process.stdin.on("data", chunk => {
            chunks.push(chunk);
            size += chunk.length;
            if (size < 1048579) return;
            const input = Buffer.concat(chunks);
            const ordered = input.length === 1048579 &&
              input.subarray(0, 1048576).equals(Buffer.alloc(1048576, "x")) &&
              input.subarray(1048576).toString() === "END";
            process.stdout.write(ordered ? "ORDERED" : "BAD_INPUT");
            process.exit(ordered ? 0 : 2);
          });
        }, 20);
        process.stdout.write("READY");
      `),
      yield_time_ms: 250,
    });
    assert.equal(first.details.output, "READY");
    const started = performance.now();
    const blocked = await h.call("queue large input", {
      session_id: first.details.session_id, chars: "x".repeat(1048576), yield_time_ms: 250,
    }, "write_stdin");
    assert(performance.now() - started < 1500, "backpressure exceeded the wait window");
    assertProcessResult(blocked.details, { output: "", session_id: first.details.session_id });
    const next = await h.call("queue input suffix", {
      session_id: first.details.session_id, chars: "END", yield_time_ms: 250,
    }, "write_stdin");
    assertProcessResult(next.details, { output: "", session_id: first.details.session_id });
    writeFileSync(gate, "");
    const final = await h.call("drain ordered input", { session_id: first.details.session_id }, "write_stdin");
    assertProcessResult(final.details, { output: "ORDERED", exit_code: 0 });
  } finally { await h.close(); }
});

test("PTY provides a real terminal, accepts input and delivers Ctrl+C to its foreground process", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const first = await h.call("read terminal", {
      command: "exec " + node(`
        if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(4);
        process.stdout.write("TTY_READY\\n");
        process.stdin.on("data", data => process.stdout.write("ANSWER:" + data));
        process.on("SIGINT", () => { process.stdout.write("INTERRUPTED\\n"); process.exit(130); });
      `),
      tty: true, yield_time_ms: 250,
    });
    assert.equal(first.isError, false);
    assert.match(first.details.output, /TTY_READY/);
    const answer = await h.call("answer terminal", {
      session_id: first.details.session_id, chars: "hello\n",
    }, "write_stdin");
    assert.match(answer.details.output, /ANSWER:hello/);
    assert.equal(answer.details.session_id, first.details.session_id);
    const final = await h.call("interrupt terminal", {
      session_id: first.details.session_id, chars: "\u0003", yield_time_ms: 1000,
    }, "write_stdin");
    assert.match(final.details.output, /INTERRUPTED/);
    assert.equal(final.details.exit_code, 130);
    assert.equal(final.details.session_id, undefined);
  } finally { await h.close(); }
});
