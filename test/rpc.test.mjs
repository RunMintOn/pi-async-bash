import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TestRpc } from "./rpc-client.mjs";
import { assertProcessResult, node, quote, textOf } from "./support.mjs";

function assertStopped(pid) {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  assert(state === "" || state.startsWith("Z"), "process still running: " + pid + " " + state);
}

test("real RPC: model waits for a result, nested sessions survive reload and fork, PTY Ctrl+C and quit clean up", { timeout: 45000 }, async (t) => {
  const rpc = new TestRpc();
  let reopened;
  t.diagnostic("RPC artifacts: " + rpc.dir);
  try {
    await rpc.ready();
    const journey = await rpc.prompt("RUN " + JSON.stringify({
      command: node('process.stdout.write("JOURNEY_START\\n"); setTimeout(() => { process.stdout.write("JOURNEY_DONE\\n"); process.exit(7); }, 900);'),
      yield_time_ms: 250,
    }));
    assert.equal(journey.length, 2);
    assert.equal(journey[0].toolName, "bash");
    assert.equal(journey[1].toolName, "write_stdin");
    assert.equal(typeof journey[0].details.session_id, "number");
    assertProcessResult(journey[1].details, { output: "JOURNEY_DONE\n", exit_code: 7 });
    assert.match((await rpc.send("get_last_assistant_text")).text, /JOURNEY_DONE/);
    const nonzero = await rpc.call("codemode", {
      code: 'return await tools.bash({ command: "printf NESTED_FAILURE; exit 7" });',
    });
    assert.match(textOf(nonzero), /"output":"NESTED_FAILURE"/);
    assert.match(textOf(nonzero), /"exit_code":7/);
    assert.match(textOf(nonzero), /"truncated":false/);
    assert.match(textOf(nonzero), /"wall_time_seconds":[\d.]+/);

    const inputCommand = node('process.stdout.write("NESTED_READY\\n"); process.stdin.on("data", data => process.stdout.write("NESTED:" + data));');
    const nested = await rpc.call("codemode", {
      code: `return await tools.bash(${JSON.stringify({ command: inputCommand, yield_time_ms: 250 })});`,
    });
    const id = Number(textOf(nested).match(/"session_id":(\d+)/)?.[1]);
    assert(Number.isInteger(id) && id > 0, textOf(nested));
    const owner = (await rpc.send("get_state")).sessionFile;
    await rpc.send("prompt", { message: "/test-reload" });
    const afterReload = await rpc.call("codemode", {
      code: `return await tools.write_stdin(${JSON.stringify({ session_id: id, chars: "reload\n" })});`,
    });
    assert.match(textOf(afterReload), /NESTED:reload/);
    assert.match(textOf(afterReload), /"truncated":false/);
    assert.match(textOf(afterReload), /"wall_time_seconds":[\d.]+/);
    await rpc.send("new_session");
    const denied = await rpc.call("write_stdin", { session_id: id, chars: "bad\n" });
    assert.equal(denied.isError, true);
    await rpc.send("switch_session", { sessionPath: owner });
    await rpc.send("clone");
    const inherited = await rpc.call("write_stdin", { session_id: id, chars: "fork\n" });
    assert.equal(inherited.details.output, "NESTED:fork\n");

    const pty = await rpc.call("bash", {
      command: "exec " + node('process.stdout.write("PTY_RPC_READY\\n"); process.stdin.resume(); process.on("SIGINT", () => { process.stdout.write("PTY_RPC_INTERRUPTED\\n"); process.exit(130); });'),
      tty: true, yield_time_ms: 250,
    });
    assert.equal(typeof pty.details.session_id, "number", textOf(pty));
    const interrupted = await rpc.call("write_stdin", { session_id: pty.details.session_id, chars: "\u0003", yield_time_ms: 1000 });
    assert.equal(interrupted.details.exit_code, 130);
    assert.match(interrupted.details.output, /PTY_RPC_INTERRUPTED/);

    const quitProcesses = [];
    for (const tty of [false, true]) {
      const path = join(rpc.dir, tty ? "quit-pty.pid" : "quit-pipe.pid");
      const started = await rpc.call("bash", {
        command: `echo $$ > ${quote(path)}; exec sleep 100`, tty, yield_time_ms: 250,
      });
      assert.equal(typeof started.details.session_id, "number");
      quitProcesses.push({ id: started.details.session_id, pid: Number(readFileSync(path, "utf8")) });
    }
    assert(!rpc.events.some(event => event.type === "message_end" && event.message.role === "custom"),
      "the runtime injected completion or snapshot messages");
    await rpc.close();
    for (const entry of quitProcesses) assertStopped(entry.pid);
    reopened = new TestRpc(rpc.dir);
    await reopened.ready();
    for (const entry of quitProcesses) {
      const unavailable = await reopened.call("write_stdin", { session_id: entry.id });
      assert.equal(unavailable.isError, true);
      assert.match(textOf(unavailable), /Unknown or unavailable/);
    }
    assert(!/uncaught|unhandled/i.test(rpc.stderr), rpc.stderr);
  } finally { await reopened?.close(); await rpc.close(); }
});

test("terminating the real Pi process cleans its managed pipe and PTY children", { timeout: 20000 }, async (t) => {
  const rpc = new TestRpc();
  t.diagnostic("Signal-cleanup artifacts: " + rpc.dir);
  try {
    await rpc.ready();
    const children = [];
    for (const tty of [false, true]) {
      const file = join(rpc.dir, tty ? "signal-pty.pid" : "signal-pipe.pid");
      await rpc.call("bash", { command: `echo $$ > ${quote(file)}; exec sleep 100`, tty, yield_time_ms: 250 });
      children.push(Number(readFileSync(file, "utf8")));
    }
    rpc.child.kill("SIGTERM");
    await rpc.exited;
    for (const pid of children) assertStopped(pid);
  } finally { await rpc.close(); }
});
