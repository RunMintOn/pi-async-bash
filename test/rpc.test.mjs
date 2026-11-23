import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TestRpc } from "./rpc-client.mjs";
import { delay, quote, textOf } from "./support.mjs";

const completions = messages => messages.filter(m => m.role === "custom" && m.customType === "async-bash-completion");

test("Pi RPC: one handoff per command, wait and cancellation, original-session wake, timeout and quit", { timeout: 60000 }, async t => {
  const rpc = new TestRpc();
  t.diagnostic("RPC artifacts: " + rpc.dir);
  try {
    await rpc.ready();
    const specs = ["waited", "nested", "cancelled", "switched", "stopped", "quit", "timeout"].map(name => {
      const gate = join(rpc.dir, name);
      const pid = gate + ".pid";
      const longLine = name === "nested" ? "printf 'LONG_DIAGNOSTIC%5000s\\n' '' >&2; " : "";
      const command = `echo $$ > ${quote(pid)}; printf '${name}:start\\n'; ` +
        `while [ ! -f ${quote(gate)} ]; do sleep 0.05; done; ${longLine}printf '${name}:fail' >&2; exit 7`;
      return { name, gate, pid, command };
    });
    const starts = await rpc.prompt("CALL " + JSON.stringify(specs.map(({ name, command }) => ({
      name: "bash", args: { command, ...(name === "timeout" ? { timeout: 39 } : {}) },
    }))));
    const owner = (await rpc.send("get_state")).sessionFile;
    assert.equal(starts.length, specs.length);
    assert.match(textOf(starts[0]), /Pi will deliver the final result to this conversation automatically\. Continue independent work, or end your turn to wait\./);
    const refs = Object.fromEntries(starts.map((start, i) => {
      const { name } = specs[i];
      assert.deepEqual(Object.keys(start.details).sort(), ["log_path", "status", "task_id"]);
      assert.equal(start.details.status, "running");
      assert.equal(readFileSync(start.details.log_path, "utf8"), `${name}:start\n`);
      return [name, { ...specs[i], ...start.details }];
    }));

    const snapshot = await rpc.call("bash_task", { task_id: refs.waited.task_id, wait_seconds: 0.02 });
    assert.equal(snapshot.details.status, "running");
    assert.equal(snapshot.details.output_tail, "waited:start\n");
    assert.match(textOf(snapshot), /^Output so far \(1 line\)$/m);
    assert.doesNotMatch(textOf(snapshot), /end your turn/);
    const oversized = await rpc.call("bash_task", { task_id: refs.waited.task_id, wait_seconds: 301 });
    assert.equal(oversized.isError, true);
    // Only the synchronous Bash tool is available to the script.
    const exposure = await rpc.call("codemode", {
      code: "return ALL_TOOLS.filter(tool => tool.name.startsWith('bash')).map(tool => tool.name);",
    });
    assert.match(textOf(exposure), /\["bash_sync"\]/);
    const missing = await rpc.call("codemode", { code: "return tools.bash;" });
    assert.match(textOf(missing), /tools\.bash does not exist/);

    const waitStart = () => rpc.wait(e => e.type === "tool_execution_start" && e.toolName === "bash_task", rpc.events.length);
    let started = waitStart();
    const waiting = rpc.call("bash_task", { task_id: refs.waited.task_id });
    await started;
    writeFileSync(refs.waited.gate, "");
    const final = await waiting;
    assert.equal(final.isError, true);
    assert.equal(final.details.exit_code, 7);
    assert.equal(final.details.output_tail, "waited:start\nwaited:fail");
    assert.match(textOf(final), /^Complete output \(2 lines\)$/m);
    assert.equal(readFileSync(refs.waited.log_path, "utf8"), final.details.output_tail);
    assert.equal(completions((await rpc.send("get_messages")).messages).length, 0);

    started = waitStart();
    const cancelling = rpc.call("bash_task", { task_id: refs.cancelled.task_id });
    await started;
    await rpc.send("abort");
    await cancelling;
    const notification = id => rpc.wait(e => e.type === "message_end" &&
      e.message.role === "custom" && e.message.details?.task_id === id, rpc.events.length);
    let delivered = notification(refs.cancelled.task_id);
    writeFileSync(refs.cancelled.gate, "");
    assert.equal((await delivered).message.details.exit_code, 7);
    await rpc.wait(e => e.type === "agent_settled", rpc.events.findLastIndex(e =>
      e.type === "message_end" && e.message.details?.task_id === refs.cancelled.task_id));
    assert.match((await rpc.send("get_last_assistant_text")).text, /cancelled:fail/);

    delivered = rpc.wait(e => (e.type === "message_end" && e.message.details?.task_id === refs.nested.task_id) ||
      (e.type === "entry_appended" && e.entry.details?.task_id === refs.nested.task_id), rpc.events.length);
    const scriptStart = rpc.wait(e => e.type === "tool_execution_start" && e.toolName === "codemode", rpc.events.length);
    const nestedRun = rpc.call("codemode", {
      code: 'return await tools.bash_sync({ command: "printf SYNC_OK; exit 3" });',
    });
    await scriptStart;
    writeFileSync(refs.nested.gate, "");
    const synced = textOf(await nestedRun);
    assert.match(synced, /"output":"SYNC_OK"/);
    assert.match(synced, /"exit_code":3/);
    const nestedDelivery = await delivered;
    const nestedResult = nestedDelivery.entry ?? nestedDelivery.message;
    assert.equal(nestedResult.details.exit_code, 7);
    assert.equal(nestedResult.details.output_tail, "nested:fail");
    assert.match(textOf(nestedResult), /^Output truncated \(showing line 3\)$/m);
    assert.match(readFileSync(refs.nested.log_path, "utf8"), /LONG_DIAGNOSTIC/);
    assert.match((await rpc.send("get_last_assistant_text")).text, /nested:fail/);

    await rpc.send("new_session");
    const denied = await rpc.call("bash_task", { task_id: refs.switched.task_id, wait_seconds: 0 });
    assert.match(textOf(denied), /Unknown or unavailable bash task/);
    writeFileSync(refs.switched.gate, "");
    for (let tries = 0; tries < 40; tries++) {
      if (readFileSync(refs.switched.log_path, "utf8").endsWith("switched:fail")) break;
      await delay(25);
    }
    assert.equal(completions((await rpc.send("get_messages")).messages).length, 0);
    delivered = notification(refs.switched.task_id);
    await rpc.send("switch_session", { sessionPath: owner });
    assert.equal((await delivered).message.details.output_tail, "switched:start\nswitched:fail");

    delivered = notification(refs.stopped.task_id);
    await rpc.send("prompt", { message: "/bash-stop " + refs.stopped.task_id });
    assert.equal((await delivered).message.details.status, "stopped");
    await rpc.wait(e => e.type === "agent_settled", rpc.events.findLastIndex(e =>
      e.type === "message_end" && e.message.details?.task_id === refs.stopped.task_id));
    const stopped = await rpc.call("bash_task", { task_id: refs.stopped.task_id, wait_seconds: 0 });
    assert.equal(stopped.details.status, "stopped");
    const timedOut = await rpc.call("bash_task", { task_id: refs.timeout.task_id });
    assert.equal(timedOut.details.status, "timed_out");
    assert.equal(timedOut.details.output_tail, "timeout:start\n");
    const slowNotifications = completions((await rpc.send("get_messages")).messages);
    for (const name of ["nested", "cancelled", "switched"]) {
      assert.equal(slowNotifications.filter(m => m.details.task_id === refs[name].task_id).length, 1);
    }
    assert(!slowNotifications.some(m => m.details.task_id === refs.waited.task_id));

    const quitPid = readFileSync(refs.quit.pid, "utf8").trim();
    await rpc.close();
    assert(!existsSync(refs.quit.log_path));
    const state = spawnSync("ps", ["-o", "stat=", "-p", quitPid], { encoding: "utf8" }).stdout.trim();
    assert(state === "" || state.startsWith("Z"), "shell still running after Pi quit: " + quitPid);
  } finally { await rpc.close(); }
});
