import assert from "node:assert/strict";
import test from "node:test";
import { realpathSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { harness, textOf, eventOnce } from "./support.mjs";

test("short bash preserves output, errors, cwd, prefix and session environment", async () => {
  const h = await harness({ shellCommandPrefix: "export PREFIX_MARK=kept" });
  try {
    const ok = await h.call("short", { command: "printf '%s|%s|%s' \"$PREFIX_MARK\" \"$PWD\" \"$PI_SESSION_ID\"" });
    assert.equal(textOf(ok), `kept|${realpathSync(h.dir)}|${h.runtime.session.sessionId}`);
    assert.equal(ok.isError, false);
    const failed = await h.call("failed", { command: "printf failure; exit 7" });
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /failure[\s\S]*Command exited with code 7/);
    const timeout = await h.call("timeout", { command: "printf before; sleep 2", timeout: 0.05 });
    assert.equal(timeout.isError, true);
    assert.match(textOf(timeout), /before[\s\S]*timed out after 0.05 seconds/);
  } finally { await h.close(); }
});

test("foreground cancellation stops the real process group and invalid timeouts still fail", async () => {
  const h = await harness();
  try {
    const pidFile = join(h.dir, "foreground-child.pid");
    h.commands.set("cancel foreground", { command: `sleep 100 & echo $! > '${pidFile}'; printf READY; wait` });
    const ready = eventOnce(h.runtime.session, (e) => e.type === "tool_execution_update" && textOf(e.partialResult).includes("READY"));
    const running = h.runtime.session.prompt("cancel foreground");
    await ready;
    const pid = Number(readFileSync(pidFile, "utf8"));
    await h.runtime.session.abort();
    await running;
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    assert(state === "" || state.startsWith("Z"), `foreground child still running: ${state}`);
    const invalid = await h.call("invalid timeout", { command: "printf should-not-run", timeout: -1 });
    assert.equal(invalid.isError, true);
    assert.match(textOf(invalid), /Invalid timeout/);
    assert(!textOf(invalid).includes("should-not-run"));
  } finally { await h.close(); }
});

test("tool_call restrictions still block shell execution and invalid shells fail before handoff", async () => {
  const blocked = await harness({}, [(pi) => {
    pi.on("tool_call", (event) => event.toolName === "bash"
      ? { block: true, reason: "Test execution policy" } : undefined);
  }]);
  try {
    const result = await blocked.call("blocked", { command: "printf must-not-execute" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Test execution policy/);
    assert(!textOf(result).includes("must-not-execute"));
  } finally { await blocked.close(); }
  const invalid = await harness({ shellPath: "/does-not-exist/async-bash-shell" });
  try {
    const result = await invalid.call("invalid shell", { command: "printf must-not-execute" });
    assert.equal(result.isError, true);
    assert.equal(result.details?.task_id, undefined);
    assert(!textOf(result).includes("must-not-execute"));
  } finally { await invalid.close(); }
});

test("bash_task rejects the removed wait action before looking up a task", async () => {
  const h = await harness();
  try {
    const result = await h.call("removed wait", { task_id: "00000000", action: "wait" }, "bash_task");
    assert.equal(result.isError, true);
    assert.match(textOf(result), /action/);
    assert(!textOf(result).includes("Unknown task"));
  } finally { await h.close(); }
});

test("cancellation at the handoff decision stops the command instead of losing an unreported task", async (t) => {
  const h = await harness();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pidFile = join(h.dir, "race-child.pid");
    h.commands.set("cancel at handoff", { command: `sleep 100 & echo $! > '${pidFile}'; printf RACE_READY; wait` });
    const ready = eventOnce(h.runtime.session, (e) => e.type === "tool_execution_update" && textOf(e.partialResult).includes("RACE_READY"));
    const running = h.runtime.session.prompt("cancel at handoff");
    await ready;
    const pid = Number(readFileSync(pidFile, "utf8"));
    t.mock.timers.tick(63000);
    // Abort before the resolved deadline promise can commit its handoff.
    await h.runtime.session.abort();
    await running;
    const results = h.runtime.session.messages.filter((m) => m.role === "toolResult");
    assert(results.some((r) => r.isError && /aborted/i.test(textOf(r))));
    assert(!results.some((r) => r.details?.status === "running"));
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    assert(state === "" || state.startsWith("Z"), `race left a running child: ${state}`);
  } finally { t.mock.timers.reset(); await h.close(); }
});

test("a 32-second execution timeout stays foreground beyond the old handoff deadline", { timeout: 10000 }, async (t) => {
  const h = await harness();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ready = eventOnce(h.runtime.session, (e) =>
      e.type === "tool_execution_update" && textOf(e.partialResult).includes("TIMEOUT_READY"));
    let returned = false;
    const running = h.call("timeout before handoff", {
      command: "printf TIMEOUT_READY; sleep 100", timeout: 32,
    }).then((result) => { returned = true; return result; });
    await ready;
    t.mock.timers.tick(15000);
    await new Promise(setImmediate);
    assert.equal(returned, false, "execution timeout must not opt into the old 15-second handoff");
    t.mock.timers.tick(17000);
    const result = await running;
    assert.equal(result.details?.task_id, undefined);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /TIMEOUT_READY[\s\S]*timed out after 32 seconds/);
  } finally { t.mock.timers.reset(); await h.close(); }
});

test("long bash hands off once after 63 seconds and completes through notification", { timeout: 85000 }, async () => {
  const h = await harness();
  try {
    const started = performance.now();
    const result = await h.call("long", {
      command: "printf 'early\\n'; sleep 65; printf 'late\\n'; exit 7",
    });
    const taskId = result.details?.task_id;
    assert.equal(typeof taskId, "string", textOf(result));
    assert(performance.now() - started >= 62000, "handed off before the 63-second waiting window");
    assert.match(taskId, /^[0-9a-f]{8}$/);
    assert.match(textOf(result), /63 seconds|63s/);
    const status = await h.call("status", { task_id: taskId, action: "status" }, "bash_task");
    assert.equal(status.details.status, "running");
    assert.match(textOf(status), /early/);
    const completed = eventOnce(h.runtime.session, (e) =>
      e.type === "message_end" && e.message.role === "custom" && e.message.details?.task_id === taskId, 5000);
    const resumed = eventOnce(h.runtime.session, (e) =>
      e.type === "agent_settled" && h.runtime.session.messages.some((m) => m.role === "custom" && m.details?.task_id === taskId), 5000);
    const [notification] = await Promise.all([completed, resumed]);
    assert.match(textOf(notification.message), /exited.*exit_code=7/);
    const final = await h.call("final status", { task_id: taskId, action: "status" }, "bash_task");
    assert.notEqual(final.isError, true);
    assert.equal(final.details.exit_code, 7);
    assert.equal(readFileSync(final.details.log_path, "utf8"), "early\nlate\n");
    const killed = await h.call("kill finished", { task_id: taskId, action: "kill" }, "bash_task");
    assert.equal(killed.details.status, "exited");
    assert.equal(killed.details.exit_code, 7);
  } finally { await h.close(); }
});
