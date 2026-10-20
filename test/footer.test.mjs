import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { harness, eventOnce, textOf, pi } from "./support.mjs";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

function footer() {
  const updates = [];
  const statuses = new Map();
  return {
    updates,
    get text() { return statuses.get("async-bash"); },
    render(session, width) {
      pi.initTheme("dark", false);
      return new pi.FooterComponent(session, {
        getGitBranch: () => null, getAvailableProviderCount: () => 1,
        getExtensionStatuses: () => statuses,
      }).render(width).map(stripTerminalSequences);
    },
    binding: { mode: "tui", uiContext: {
      setStatus(key, value) {
        updates.push([key, value]);
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
    } },
  };
}

async function start(h, t, name) {
  const gate = join(h.dir, name);
  const ready = eventOnce(h.runtime.session, e =>
    e.type === "tool_execution_update" && textOf(e.partialResult).includes(`READY_${name}`));
  const result = h.call(name, {
    command: `printf READY_${name}; while [ ! -f '${gate}' ]; do sleep 0.02; done; printf DONE_${name}`,
  });
  await ready;
  t.mock.timers.tick(63000);
  return { gate, result: await result };
}

test("footer counts only handed-off tasks, ticks each age and removes finished tasks", { timeout: 15000 }, async (t) => {
  const ui = footer();
  const h = await harness({}, [], { binding: ui.binding });
  try {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000000 });
    writeFileSync(join(h.dir, "agent", "extension-data", "async-bash", "deadbeef.json"), JSON.stringify({
      task_id: "deadbeef", owner_session_id: h.runtime.session.sessionId, status: "running",
      started_at: 1, exit_code: null,
    }));
    assert.equal(ui.text, undefined);
    const ready = eventOnce(h.runtime.session, e =>
      e.type === "tool_execution_update" && textOf(e.partialResult).includes("READY_first"));
    const first = h.call("first", {
      command: `printf READY_first; while [ ! -f '${join(h.dir, "first")}' ]; do sleep 0.02; done`,
    });
    await ready;
    t.mock.timers.tick(62000);
    await new Promise(setImmediate);
    assert.equal(ui.text, undefined, "foreground execution is not a background task");
    t.mock.timers.tick(1000);
    const firstResult = await first;
    assert.equal(ui.text, "BG 1 · 1m 03s");
    t.mock.timers.tick(1000);
    assert.equal(ui.text, "BG 1 · 1m 04s");

    const second = await start(h, t, "second");
    assert.equal(ui.text, "BG 2 · 2m 07s / 1m 03s");
    assert(!ui.text.includes(firstResult.details.task_id));
    ui.binding.uiContext.setStatus("minutes-footer", "[idle 0 min]");
    assert.equal(ui.render(h.runtime.session, 80).at(-1), "BG 2 · 2m 07s / 1m 03s [idle 0 min]");
    t.diagnostic(`Native footer at 80 columns:\n${ui.render(h.runtime.session, 80).join("\n")}`);
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    try {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 20 });
      process.stdout.emit("resize");
      assert.equal(ui.text, "BG 2 · 2m07s / +1");
      assert.match(ui.render(h.runtime.session, 20).at(-1), /\+1/);
      t.diagnostic(`Native footer at 20 columns:\n${ui.render(h.runtime.session, 20).join("\n")}`);
    } finally {
      if (columns) Object.defineProperty(process.stdout, "columns", columns);
      else delete process.stdout.columns;
      process.stdout.emit("resize");
    }
    assert.equal(ui.text, "BG 2 · 2m 07s / 1m 03s");
    const completed = eventOnce(h.runtime.session, e => e.type === "agent_settled" &&
      h.runtime.session.messages.some(m => m.role === "custom" && m.details?.task_id === second.result.details.task_id));
    writeFileSync(second.gate, "");
    await completed;
    assert.equal(ui.text, "BG 1 · 2m 07s");
    await h.call("stop first", { task_id: firstResult.details.task_id, action: "kill" }, "bash_task");
    assert.equal(ui.text, undefined);
    const count = ui.updates.length;
    t.mock.timers.tick(5000);
    assert.equal(ui.updates.length, count, "idle footer must not retain a timer");
  } finally {
    t.mock.timers.reset();
    await h.close();
  }
});

test("footer follows current session and inherited references, survives reload without duplicate timers", { timeout: 15000 }, async (t) => {
  const ui = footer();
  const h = await harness({}, [], { binding: ui.binding });
  try {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000000 });
    const first = await start(h, t, "owner");
    const ownerFile = h.runtime.session.sessionFile;
    const ownerId = h.runtime.session.sessionId;
    assert.equal(ui.text, "BG 1 · 1m 03s");
    await h.runtime.newSession();
    assert.equal(ui.text, undefined);
    t.mock.timers.tick(1000);
    assert.equal(ui.text, undefined);
    await h.runtime.switchSession(ownerFile);
    assert.equal(ui.text, "BG 1 · 1m 04s");
    await h.runtime.session.reload();
    await h.runtime.session.reload();
    const beforeTick = ui.updates.length;
    t.mock.timers.tick(1000);
    assert.equal(ui.text, "BG 1 · 1m 05s");
    assert.equal(ui.updates.length, beforeTick + 1, "reload must leave just one ticking status");

    await h.runtime.session.prompt("fork checkpoint");
    const entry = h.runtime.session.sessionManager.getBranch().findLast(e =>
      e.type === "message" && e.message.role === "user");
    await h.runtime.fork(entry.id, { position: "at" });
    assert.notEqual(h.runtime.session.sessionId, ownerId);
    assert.equal(ui.text, "BG 1 · 1m 05s", "fork retains the same live task reference");
    await h.call("stop inherited", { task_id: first.result.details.task_id, action: "kill" }, "bash_task");
    assert.equal(ui.text, undefined);
    await h.close();
    const closedAt = ui.updates.length;
    t.mock.timers.tick(3000);
    assert.equal(ui.updates.length, closedAt, "shutdown removes status timers and subscriptions");
  } finally {
    t.mock.timers.reset();
    await h.close();
  }
});

test("footer includes bash handed off inside codemode", { timeout: 15000 }, async (t) => {
  const ui = footer();
  const h = await harness({}, [pi.createCodemodeExtension()], {
    binding: ui.binding, tools: ["bash", "bash_task", "codemode"],
  });
  try {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000000 });
    const ready = eventOnce(h.runtime.session, e =>
      e.type === "tool_execution_update" && textOf(e.partialResult).includes("NESTED_READY"));
    const running = h.call("nested", {
      code: "return await tools.bash({command: 'printf NESTED_READY; sleep 100'});",
    }, "codemode");
    await ready;
    t.mock.timers.tick(63000);
    const result = await running;
    assert.match(textOf(result), /"status":"running"/);
    assert.equal(ui.text, "BG 1 · 1m 03s");
    const id = textOf(result).match(/"task_id":"([^"]+)"/)[1];
    await h.call("stop nested", { task_id: id, action: "kill" }, "bash_task");
    assert.equal(ui.text, undefined);
  } finally {
    t.mock.timers.reset();
    await h.close();
  }
});
