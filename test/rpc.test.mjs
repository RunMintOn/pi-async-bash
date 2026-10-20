import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TestRpc } from "./rpc-client.mjs";
import { textOf } from "./support.mjs";

test("real RPC: automatic handoff, nested structured output, controls, reload, session ownership and quit", { timeout: 150000 }, async (t) => {
  const rpc = new TestRpc();
  let reopened;
  t.diagnostic(`RPC artifacts: ${rpc.dir}`);
  try {
    const initial = await rpc.ready();
    const owner = initial.sessionId;
    const gate = (name) => join(rpc.dir, name);
    const hold = (name, exit = 0) => `printf 'early\\n'; while [ ! -f '${gate(name)}' ]; do sleep 0.05; done; printf 'late\\n'; exit ${exit}`;
    const since = rpc.events.length;
    const batch = [
      { name: "bash", args: { command: hold("notify", 9), timeout: 150 } },
      { name: "bash", args: { command: "printf timed; sleep 100", timeout: 66 } },
      { name: "bash", args: { command: `sleep 100 & echo $! > '${gate("child.pid")}'; wait`, timeout: 150 } },
      { name: "codemode", args: { code: `const r = await tools.bash(${JSON.stringify({
        command: `echo $$ > '${gate("nested.pid")}'; "${process.execPath}" -e 'process.stdout.write("中".repeat(100000))'; ${hold("nested")}`, timeout: 150,
      })}); return r;` } },
    ];
    const results = await rpc.prompt("CALL " + JSON.stringify(batch));
    assert.equal(results.length, 4);
    const [notify, timed, kill, nested] = results;
    const id = notify.details.task_id;
    assert.equal(notify.details.status, "running");
    assert.equal(timed.details.status, "running");
    assert.equal(kill.details.status, "running");
    assert.match(textOf(nested), /"task_id":/);
    assert.match(textOf(nested), /"status":"running"/);
    const nestedId = textOf(nested).match(/"task_id":"([^"]+)"/)[1];
    const ownerFile = (await rpc.send("get_state")).sessionFile;
    await rpc.send("clone");
    await rpc.prompt("STATE_NESTED_FORK");
    assert((await rpc.send("get_last_assistant_text")).text.includes(nestedId), "fork lost the task reference returned through codemode");
    await rpc.send("switch_session", { sessionPath: ownerFile });
    const processed = await rpc.prompt("USER_BEFORE_COMPLETION");
    assert.deepEqual(processed, []);
    assert(!rpc.events.slice(since).some((e) => e.type === "message_end" && e.message.role === "custom" && e.message.details?.task_id === id));

    const entries = await rpc.send("get_entries");
    const startEntry = entries.entries.find((e) => e.type === "message" && e.message.role === "toolResult" && e.message.details?.task_id === id);
    assert(startEntry);
    await rpc.send("prompt", { message: "/test-reload" });
    const stillRunning = await rpc.call("bash_task", { task_id: id, action: "status" });
    assert.equal(stillRunning.details.status, "running");
    assert.match(textOf(stillRunning), /early/);

    const killed = await rpc.call("bash_task", { task_id: kill.details.task_id, action: "kill" });
    assert.equal(killed.details.status, "killed");
    const childPid = Number(readFileSync(gate("child.pid"), "utf8"));
    const alive = (() => { try { process.kill(childPid, 0); return true; } catch { return false; } })();
    if (alive) {
      // Some systems briefly retain a killed descendant as a zombie.
      const { spawnSync } = await import("node:child_process");
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(childPid)], { encoding: "utf8" }).stdout.trim();
      assert(state === "" || state.startsWith("Z"), `child still running: ${state}`);
    }

    const timeoutNotice = await rpc.wait((e) => e.type === "message_end" &&
      e.message.role === "custom" && e.message.details?.task_id === timed.details.task_id);
    await rpc.wait((e) => e.type === "agent_settled", rpc.events.indexOf(timeoutNotice) + 1);
    const timeoutResult = await rpc.call("bash_task", { task_id: timed.details.task_id, action: "status" });
    assert.equal(timeoutResult.details.status, "timed_out");
    assert.notEqual(timeoutResult.isError, true);
    assert.match(textOf(timeoutResult), /timed/);
    assert(timeoutResult.details.wall_time_seconds < 70, "execution timeout was reset at handoff");

    await rpc.send("new_session");
    assert.notEqual((await rpc.send("get_state")).sessionId, owner);
    const awayAt = rpc.events.length;
    writeFileSync(gate("notify"), "");
    await delay(100);
    assert(!rpc.events.slice(awayAt).some((e) => e.type === "message_end" && e.message.role === "custom" && e.message.details?.task_id === id));
    await rpc.send("switch_session", { sessionPath: ownerFile });
    const resumeAt = rpc.events.length;
    await rpc.prompt("STATE_AFTER_RESUME");
    assert.match((await rpc.send("get_last_assistant_text")).text, new RegExp(`Task ${id}: exited; exit_code=9`));
    assert(!rpc.events.slice(resumeAt).some((e) => e.type === "message_end" && e.message.role === "custom"));
    const final = await rpc.call("bash_task", { task_id: id, action: "status" });
    assert.equal(final.details.exit_code, 9);
    assert.equal(readFileSync(final.details.log_path, "utf8"), "early\nlate\n");
    await rpc.send("prompt", { message: `/test-tree ${startEntry.id}` });
    assert.equal((await rpc.send("get_state")).sessionId, owner);
    const treeAt = rpc.events.length;
    await rpc.prompt("USER_AFTER_TREE");
    assert(!rpc.events.slice(treeAt).some((e) => e.type === "message_end" && e.message.role === "custom"));
    await rpc.send("clone");
    assert.notEqual((await rpc.send("get_state")).sessionId, owner);
    const inherited = await rpc.call("bash_task", { task_id: id, action: "status" });
    assert.equal(inherited.details.owner_session_id, owner);
    assert.equal(inherited.details.exit_code, 9);

    const short = await rpc.call("codemode", { code: "return await tools.bash({command: 'printf structured; exit 7'});" });
    assert.match(textOf(short), /"exit_code":7/);
    assert.match(textOf(short), /"output":"structured"/);
    const nestedStatus = await rpc.call("bash_task", { task_id: nestedId, action: "status" });
    assert.equal(nestedStatus.details.status, "running");
    assert(Buffer.byteLength(nestedStatus.details.output) <= 16384);
    assert(!nestedStatus.details.output.includes("\uFFFD"));
    assert(nestedStatus.details.total_bytes >= 300000);
    await rpc.close();
    const nestedPid = Number(readFileSync(gate("nested.pid"), "utf8"));
    const { spawnSync } = await import("node:child_process");
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(nestedPid)], { encoding: "utf8" }).stdout.trim();
    assert(state === "" || state.startsWith("Z"), `task still running after quit: ${state}`);
    reopened = new TestRpc(rpc.dir);
    await reopened.ready();
    const persisted = await reopened.call("bash_task", { task_id: nestedId, action: "status" });
    assert.equal(persisted.details.status, "killed");
    assert(!/stale|uncaught|unhandled/i.test(rpc.stderr), rpc.stderr);
  } finally { await reopened?.close(); await rpc.close(); }
});

test("after a real pi crash, a new runtime reports unknown and never adopts the old process", { timeout: 95000 }, async (t) => {
  const original = new TestRpc();
  let restored;
  let shellPid;
  t.diagnostic(`Crash/recovery artifacts: ${original.dir}`);
  try {
    await original.ready();
    const pidFile = join(original.dir, "crash-shell.pid");
    const running = await original.call("bash", {
      command: `echo $$ > '${pidFile}'; printf crash-start; sleep 100`,
      timeout: 90,
    });
    const id = running.details.task_id;
    assert.equal(running.details.status, "running");
    shellPid = Number(readFileSync(pidFile, "utf8"));
    original.child.kill("SIGKILL");
    await original.exited;
    restored = new TestRpc(original.dir);
    await restored.ready();
    const status = await restored.call("bash_task", { task_id: id, action: "status" });
    assert.equal(status.details.status, "unknown");
    assert.equal(status.details.exit_code, null);
    const kill = await restored.call("bash_task", { task_id: id, action: "kill" });
    assert.equal(kill.details.status, "unknown");
    process.kill(shellPid, 0);
    assert.equal(kill.isError, true);
  } finally {
    await restored?.close();
    await original.close();
    if (shellPid) try { process.kill(-shellPid, "SIGKILL"); } catch {}
  }
});
