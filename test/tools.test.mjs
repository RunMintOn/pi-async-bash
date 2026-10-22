import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertProcessResult, harness, node, quote, textOf } from "./support.mjs";

test("cd is per-command and preserves the configured shell, prefix and Pi session environment", async () => {
  const h = await harness({ shellPath: "/bin/bash", shellCommandPrefix: "export PREFIX_MARK=kept" });
  try {
    mkdirSync(join(h.dir, "with spaces"));
    const first = await h.call("directory", {
      command: 'cd "with spaces" && printf "%s|%s|%s|%s" "$PREFIX_MARK" "$PWD" "$PI_SESSION_ID" "$PI_MODEL"',
    });
    assert.equal(first.details.output, `kept|${realpathSync(join(h.dir, "with spaces"))}|${h.runtime.session.sessionId}|scripted`);
    const second = await h.call("original directory", { command: "printf '%s' \"$PWD\"" });
    assert.equal(second.details.output, realpathSync(h.dir));
    const failure = await h.call("nonzero", { command: "printf FAILURE; exit 9" });
    assertProcessResult(failure.details, { output: "FAILURE", exit_code: 9 });
    assert.equal(failure.isError, true);
  } finally { await h.close(); }
});

test("removed and invalid parameters are rejected before a command is executed", async () => {
  const h = await harness();
  try {
    const marker = join(h.dir, "must-not-exist");
    for (const extra of [{ workdir: "." }, { timeout: 1 }, { yield_time_ms: -1 }, { shell: "/bin/bash" }, { tty: "yes" }]) {
      const result = await h.call("invalid " + JSON.stringify(extra), { command: "touch " + quote(marker), ...extra });
      assert.equal(result.isError, true, textOf(result));
      assert.equal(existsSync(marker), false, "invalid input executed the shell command");
    }
    for (const id of [0, 1.5, "123"]) {
      const result = await h.call("invalid reference " + id, { session_id: id }, "write_stdin");
      assert.equal(result.isError, true);
    }
    const unknown = await h.call("unknown", { session_id: 123456 }, "write_stdin");
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /Unknown or unavailable/);
  } finally { await h.close(); }
});

test("tool_call policy can block execution and an invalid shell never produces a running session", async () => {
  const blocked = await harness({}, [pi => {
    pi.on("tool_call", event => event.toolName === "bash" ? { block: true, reason: "Test execution policy" } : undefined);
  }]);
  try {
    const marker = join(blocked.dir, "blocked");
    const result = await blocked.call("policy", { command: "touch " + quote(marker) });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Test execution policy/);
    assert.equal(existsSync(marker), false);
  } finally { await blocked.close(); }
  const h = await harness({ shellPath: "/does-not-exist/async-bash-shell" });
  try {
    const shell = await h.call("invalid shell", { command: "printf must-not-run" });
    assert.equal(shell.isError, true);
    assert.equal(shell.details?.session_id, undefined);
    assert.match(textOf(shell), /shell path not found/i);
  } finally { await h.close(); }
});

test("large Unicode output is bounded and the complete log remains readable", async () => {
  const h = await harness();
  try {
    const result = await h.call("large output", {
      command: node('process.stdout.write("中".repeat(50000) + "\\nLAST_LINE\\n")'),
    });
    const output = result.details.output;
    assert.equal(result.details.exit_code, 0);
    assert(Buffer.byteLength(output) < 52000, "model output exceeded its byte budget");
    assert(!output.includes("\uFFFD"), "UTF-8 was split by truncation");
    assert.match(output, /LAST_LINE/);
    const path = output.match(/\[Output truncated\. Full log: (.+)\]/)?.[1];
    assert(path, output.slice(-200));
    const full = readFileSync(path, "utf8");
    assert.equal(full, "中".repeat(50000) + "\nLAST_LINE\n");
    assert.deepEqual(Object.keys(result.details).sort(), ["exit_code", "full_output_path", "output", "truncated", "wall_time_seconds"]);
  } finally { await h.close(); }
});

test("a UTF-8 code point split across the first yield is delivered intact on the next read", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const first = await h.call("split UTF-8", {
      command: node('process.stdout.write("FIRST\\n"); process.stdout.write(Buffer.from([0xe4,0xb8])); setTimeout(() => { process.stdout.write(Buffer.from([0xad])); process.stdout.write("LAST\\n"); }, 700);'),
      yield_time_ms: 250,
    });
    assert.equal(first.details.output, "FIRST\n");
    const final = await h.call("read remainder", { session_id: first.details.session_id }, "write_stdin");
    assertProcessResult(final.details, { output: "中LAST\n", exit_code: 0 });
  } finally { await h.close(); }
});

test("parallel interactions on one process are ordered and consume each output once", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const first = await h.call("two answers", {
      command: node(`const readline = require("node:readline"); let n = 0; process.stdout.write("READY\\n"); readline.createInterface({input: process.stdin}).on("line", line => { process.stdout.write("GOT:" + line + "\\n"); if (++n === 2) process.exit(0); });`),
      yield_time_ms: 250,
    });
    h.commands.set("send both", ["A", "B"].map(letter => ({
      name: "write_stdin", args: { session_id: first.details.session_id, chars: letter + "\n" },
    })));
    const before = h.runtime.session.messages.length;
    await h.runtime.session.prompt("send both");
    const results = h.runtime.session.messages.slice(before).filter(message => message.role === "toolResult");
    assert.equal(results.length, 2);
    assert.equal(results[0].details.output, "GOT:A\n");
    assert.equal(results[1].details.output, "GOT:B\n");
    assert.equal(results[1].details.exit_code, 0);
    assert(results[1].details.wall_time_seconds >= 0.2, "call duration must include waiting behind the first interaction");
  } finally { await h.close(); }
});
