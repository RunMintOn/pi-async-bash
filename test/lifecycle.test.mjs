import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { harness, eventOnce, quote, textOf } from "./support.mjs";

test("cancelling foreground bash stops its real process group before handoff", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const file = join(h.dir, "child.pid");
    h.commands.set("cancel initial", { command: `sleep 100 & echo $! > ${quote(file)}; printf INITIAL_READY; wait` });
    const ready = eventOnce(h.runtime.session, event =>
      event.type === "tool_execution_update" && textOf(event.partialResult).includes("INITIAL_READY"));
    const running = h.runtime.session.prompt("cancel initial");
    await ready;
    const pid = readFileSync(file, "utf8").trim();
    await h.runtime.session.abort();
    await running;
    const state = spawnSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" }).stdout.trim();
    assert(state === "" || state.startsWith("Z"), "child still running: " + pid);
    const result = h.runtime.session.messages.findLast(message => message.role === "toolResult");
    assert.equal(result?.details?.task_id, undefined);
  } finally { await h.close(); }
});

test("execution timeout before handoff retains Pi's native error", async () => {
  const h = await harness();
  try {
    const result = await h.call("short timeout", { command: "printf EARLY; sleep 100", timeout: 0.1 });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /EARLY[\s\S]*Command timed out after 0\.1 seconds/);
    assert.equal(result.details?.task_id, undefined);
  } finally { await h.close(); }
});
