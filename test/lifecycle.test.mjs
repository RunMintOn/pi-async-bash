import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assertProcessResult, harness, eventOnce, node, quote, textOf, delay } from "./support.mjs";

function assertStopped(pid) {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  assert(state === "" || state.startsWith("Z"), "child still running: " + state);
}

for (const tty of [false, true]) {
  test(`shell exit cleans remaining ${tty ? "PTY" : "pipe"} group members without changing its exit code`, { timeout: 15000 }, async () => {
    const h = await harness();
    let pid;
    try {
      const file = join(h.dir, "remaining-child.pid");
      const child = node(`
        process.on("SIGHUP", () => {});
        require("node:fs").writeFileSync(${JSON.stringify(file)}, String(process.pid));
        setInterval(() => {}, 1000);
      `);
      const result = await h.call("shell leaves a child", {
        command: `${child} & while [ ! -f ${quote(file)} ]; do sleep 0.02; done; exit 7`,
        tty,
      });
      pid = Number(readFileSync(file, "utf8"));
      assert.equal(result.details.exit_code, 7);
      // Group termination and OS process reaping can complete on different ticks.
      for (let i = 0; i < 20; i++) {
        try { assertStopped(pid); return; } catch (error) {
          if (i === 19) throw error;
          await delay(25);
        }
      }
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await h.close();
    }
  });
}

test("cancelling the initial call stops its real process group before a reference is handed out", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const file = join(h.dir, "child.pid");
    h.commands.set("cancel initial", { command: `sleep 100 & echo $! > ${quote(file)}; printf INITIAL_READY; wait` });
    const ready = eventOnce(h.runtime.session, event =>
      event.type === "tool_execution_update" && textOf(event.partialResult).includes("INITIAL_READY"));
    const running = h.runtime.session.prompt("cancel initial");
    await ready;
    const pid = Number(readFileSync(file, "utf8"));
    await h.runtime.session.abort();
    await running;
    assertStopped(pid);
    assert(!h.runtime.session.sessionManager.getBranch().some(entry =>
      entry.type === "custom" && entry.customType === "async-bash-process"));
  } finally { await h.close(); }
});

test("cancelling a later wait preserves the process and output previewed during that wait", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const first = await h.call("start cancellable", {
      command: node(`process.stdout.write("READY\\n"); setTimeout(() => process.stdout.write("DURING\\n"), 900); process.stdin.once("data", () => { process.stdout.write("DONE\\n"); process.exit(0); });`),
      yield_time_ms: 250,
    });
    h.commands.set("cancel wait", { name: "write_stdin", args: { session_id: first.details.session_id } });
    const preview = eventOnce(h.runtime.session, event =>
      event.type === "tool_execution_update" && textOf(event.partialResult).includes("DURING"));
    const running = h.runtime.session.prompt("cancel wait");
    await preview;
    await h.runtime.session.abort();
    await running;
    const final = await h.call("resume after cancellation", {
      session_id: first.details.session_id, chars: "finish\n",
    }, "write_stdin");
    assertProcessResult(final.details, { output: "DURING\nDONE\n", exit_code: 0 });
  } finally { await h.close(); }
});

test("a cancelled queued interaction cannot overtake an earlier wait or consume its output", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const first = await h.call("queue cancellation", {
      command: node('process.stdout.write("READY\\n"); setTimeout(() => { process.stdout.write("FINISHED\\n"); process.exit(0); }, 1500);'),
      yield_time_ms: 250,
    });
    h.commands.set("two waits", [
      { name: "write_stdin", args: { session_id: first.details.session_id } },
      { name: "write_stdin", args: { session_id: first.details.session_id, chars: "ignored\n" } },
    ]);
    const started = eventOnce(h.runtime.session, event => event.type === "tool_execution_start" && event.toolName === "write_stdin");
    const running = h.runtime.session.prompt("two waits");
    await started;
    await delay(100);
    await h.runtime.session.abort();
    await running;
    const final = await h.call("resume queue", { session_id: first.details.session_id }, "write_stdin");
    assertProcessResult(final.details, { output: "FINISHED\n", exit_code: 0 });
  } finally { await h.close(); }
});

test("reload and session switching preserve the process, unrelated sessions cannot access it, forks inherit its reference", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const first = await h.call("owned input", {
      command: node('process.stdout.write("OWNER_READY\\n"); process.stdin.on("data", data => process.stdout.write("OWNER:" + data));'),
      yield_time_ms: 250,
    });
    const id = first.details.session_id;
    const ownerFile = h.runtime.session.sessionFile;
    await h.runtime.session.reload();
    await h.runtime.session.reload();
    const afterReload = await h.call("after reload", { session_id: id, chars: "reload\n" }, "write_stdin");
    assert.equal(afterReload.details.output, "OWNER:reload\n");
    await h.runtime.newSession();
    const denied = await h.call("unrelated", { session_id: id, chars: "must-not-arrive\n" }, "write_stdin");
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /Unknown or unavailable/);
    await h.runtime.switchSession(ownerFile);
    await h.runtime.session.prompt("fork checkpoint");
    const checkpoint = h.runtime.session.sessionManager.getBranch().findLast(entry =>
      entry.type === "message" && entry.message.role === "user");
    await h.runtime.fork(checkpoint.id, { position: "at" });
    const inherited = await h.call("inherited input", { session_id: id, chars: "fork\n" }, "write_stdin");
    assert.equal(inherited.details.output, "OWNER:fork\n");
    await h.runtime.session.prompt("/bash-stop " + id);
    const stopped = await h.call("stopped", { session_id: id }, "write_stdin");
    assert.equal(stopped.details.exit_code, 137);
  } finally { await h.close(); }
});

test("explicit stop terminates pipe and PTY process groups and preserves their final exit results", { timeout: 15000 }, async () => {
  for (const tty of [false, true]) {
    const h = await harness();
    try {
      const file = join(h.dir, "stop-child.pid");
      const first = await h.call("managed group", {
        command: `sleep 100 & echo $! > ${quote(file)}; printf STOP_READY; wait`, tty, yield_time_ms: 250,
      });
      const pid = Number(readFileSync(file, "utf8"));
      await h.runtime.session.prompt("/bash-stop " + first.details.session_id);
      assertStopped(pid);
      const result = await h.call("read stopped", { session_id: first.details.session_id }, "write_stdin");
      assert.equal(result.details.exit_code, 137);
      await h.runtime.session.prompt("/bash-stop " + first.details.session_id);
      const again = await h.call("read stopped again", { session_id: first.details.session_id }, "write_stdin");
      assertProcessResult(again.details, { output: "", exit_code: 137 });
    } finally { await h.close(); }
  }
});
