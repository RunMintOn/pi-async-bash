import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { harness, node, pi, quote, textOf } from "./support.mjs";

test("cd is per-command and retains the configured shell, prefix and Pi session environment", async () => {
  const h = await harness({ shellPath: "/bin/bash", shellCommandPrefix: "export PREFIX_MARK=kept" });
  try {
    mkdirSync(join(h.dir, "with spaces"));
    const first = await h.call("directory", {
      command: 'cd "with spaces" && printf "%s|%s|%s|%s" "$PREFIX_MARK" "$PWD" "$PI_SESSION_ID" "$PI_MODEL"',
    });
    assert.equal(textOf(first), `kept|${realpathSync(join(h.dir, "with spaces"))}|${h.runtime.session.sessionId}|scripted`);
    const second = await h.call("original directory", { command: "printf '%s' \"$PWD\"" });
    assert.equal(textOf(second), realpathSync(h.dir));
    const failure = await h.call("nonzero", { command: "printf FAILURE; exit 9" });
    assert.equal(failure.isError, true);
    assert.match(textOf(failure), /FAILURE[\s\S]*Command exited with code 9/);
  } finally { await h.close(); }
});

test("tool_call policy and native timeout validation can reject a command before it runs", async () => {
  const h = await harness({}, [pi => {
    pi.on("tool_call", event => event.toolName === "bash" && event.input.command.startsWith("touch") ?
      { block: true, reason: "Test execution policy" } : undefined);
  }]);
  try {
    const marker = join(h.dir, "blocked");
    const blocked = await h.call("policy", { command: "touch " + quote(marker) });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /Test execution policy/);
    const timeout = await h.call("invalid timeout", { command: "true && touch " + quote(marker), timeout: 0 });
    assert.equal(timeout.isError, true);
    assert.match(textOf(timeout), /Invalid timeout/);
    assert.equal(existsSync(marker), false);
  } finally { await h.close(); }
});

test("a short command's large Unicode output keeps Pi's native text limit and log", async () => {
  const h = await harness();
  try {
    const result = await h.call("large output", {
      command: node('process.stdout.write("中".repeat(50000) + "\\nLAST_LINE\\n")'),
    });
    const output = textOf(result);
    assert(Buffer.byteLength(output) < 52000);
    assert(!output.includes("\uFFFD"));
    assert.match(output, /LAST_LINE/);
    assert.equal(readFileSync(result.details.fullOutputPath, "utf8"), "中".repeat(50000) + "\nLAST_LINE\n");
  } finally { await h.close(); }
});

test("bash_sync exposes its output limit and throws a catchable command timeout", async () => {
  const h = await harness({}, [pi.createCodemodeExtension({ mode: "on", models: false })], { tools: ["+codemode"] });
  try {
    const limit = 1024 * 1024;
    const code = `
      const exact = await tools.bash_sync({ command: ${JSON.stringify(node(`process.stdout.write("x".repeat(${limit}))`))} });
      const over = await tools.bash_sync({ command: ${JSON.stringify(node(`process.stdout.write("x".repeat(${limit + 1}))`))} });
      let timeout;
      try { await tools.bash_sync({ command: "sleep 2", timeout: 0.2 }); }
      catch (error) { timeout = error.message; }
      return { exactTruncated: exact.truncated, overTruncated: over.truncated, log: over.full_output_path, timeout };
    `;
    const result = await h.call("bash_sync output and timeout", { code }, "codemode");
    const { exactTruncated, overTruncated, log, timeout } = JSON.parse(textOf(result).split("\n").at(-1));
    assert.equal(exactTruncated, false);
    assert.equal(overTruncated, true);
    assert.equal(readFileSync(log).length, limit + 1);
    assert.match(timeout, /Command timed out after 0\.2 seconds/);
  } finally { await h.close(); }
});
