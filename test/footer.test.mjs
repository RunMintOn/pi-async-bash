import assert from "node:assert/strict";
import test from "node:test";
import { TaskManager } from "../src/tasks.ts";
import { installTaskStatus } from "../src/status.ts";

test("the footer follows the owner's tasks until their results reach the conversation", async ({ mock }) => {
  mock.timers.enable({ apis: ["setInterval"] });
  const tasks = new TaskManager(10);
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const entries = [];
  const statuses = new Map();
  const bind = owner => installTaskStatus({
    mode: "tui", hasUI: true, sessionManager: {
      getSessionId: () => owner,
      getLeafId: () => String(entries.length),
      getEntries: () => entries,
    },
    ui: {
      theme: { fg: (color, text) => `{${color}:${text}}` },
      setStatus: (_, value) => statuses.set(owner, value),
    },
  }, tasks);
  const ownerStatus = () => statuses.get("owner")?.replace(/\{[^:]+:([^}]*)\}/g, "$1");
  const columns = process.stdout.columns;
  process.stdout.columns = 100;
  const off = [bind("owner"), bind("other")];
  const startTask = gate => tasks.execute("owner", undefined, async ({ start, exited }) => {
    start();
    await gate.promise;
    exited(0);
  });
  try {
    const a = await startTask(first);
    assert.match(statuses.get("owner"), /^\{dim:\[\}\{accent:1 background task\}\{muted: · \d+s\}\{dim:\]\}$/);
    const b = await startTask(second);
    assert.match(ownerStatus(), /^\[2 background tasks · \d+s \/ \d+s\]$/);

    first.resolve();
    await tasks.wait("owner", a.task_id, 1);
    assert.match(ownerStatus(), /^\[Background tasks · 1 running \(\d+s\) · 1 finished, result pending\]$/);
    assert.equal(statuses.get("other"), undefined);
    process.stdout.columns = 57;
    process.stdout.emit("resize");
    assert.equal(ownerStatus(), "[Background tasks · 1 running · 1 result pending]");

    second.resolve();
    const toolResult = await tasks.wait("owner", b.task_id, 1);
    const [notification] = tasks.takeCompletions("owner", 1);
    mock.timers.tick(1000);
    assert.equal(ownerStatus(), "[2 tasks finished · results pending]");

    entries.push({ type: "custom_message", customType: "async-bash-completion", display: true, details: notification });
    mock.timers.tick(1000);
    assert.equal(ownerStatus(), "[1 task finished · result pending]");
    entries.push({ type: "message", message: { role: "toolResult", toolName: "bash_task", details: toolResult } });
    mock.timers.tick(1000);
    assert.equal(ownerStatus(), undefined);
  } finally {
    off.forEach(unsubscribe => unsubscribe());
    process.stdout.columns = columns;
    first.resolve();
    second.resolve();
    await tasks.shutdown();
  }
});
