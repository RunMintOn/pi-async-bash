import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { extensionPath, packageRoot, textOf } from "./support.mjs";

test("one-shot Pi returns the command's result after the handoff threshold", { timeout: 55000 }, async () => {
  const prompt = "CALL " + JSON.stringify([{
    name: "bash", args: { command: "printf 'START\\n'; sleep 31; printf 'FINISHED\\n'; exit 7", timeout: 45 },
  }]);
  await Promise.all([["-p"], ["--mode", "json"]].map(async mode => {
    const dir = mkdtempSync(join(tmpdir(), "pi-async-one-shot-"));
    const run = promisify(execFile)(process.execPath, [
      join(packageRoot, "dist/bundle/cli.js"), ...mode,
      "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
      "--no-prompt-templates", "--no-session",
      "-e", extensionPath, "-e", resolve("test/fixtures/provider.ts"),
      "--provider", "async-test", "--model", "scripted", "--thinking", "off", prompt,
    ], {
      cwd: dir, timeout: 50000,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1" },
    });
    run.child.stdin.end();
    const { stdout } = await run;
    if (mode[0] === "-p") {
      assert.match(stdout, /FINISHED[\s\S]*Command exited with code 7/);
    } else {
      const events = stdout.trimEnd().split("\n").map(line => JSON.parse(line));
      const result = events.find(event => event.type === "tool_execution_end" && event.toolName === "bash");
      assert.equal(result?.isError, true);
      assert.match(textOf(result.result), /FINISHED[\s\S]*Command exited with code 7/);
    }
  }));
});
