import assert from "node:assert/strict";
import test from "node:test";
import { TaskManager } from "../src/tasks.ts";
import { installTaskStatus } from "../src/status.ts";

test("the native footer shows only running tasks owned by the displayed conversation", async () => {
  const tasks = new TaskManager(10);
  const gate = Promise.withResolvers();
  const statuses = new Map();
  const bind = owner => installTaskStatus({
    mode: "tui", hasUI: true, sessionManager: { getSessionId: () => owner },
    ui: { setStatus: (_, value) => statuses.set(owner, value) },
  }, tasks);
  const off = [bind("owner"), bind("other")];
  try {
    const ref = await tasks.execute("owner", undefined, async ({ start }) => {
      start();
      await gate.promise;
      return { structuredContent: { exit_code: 0 } };
    });
    assert.match(statuses.get("owner"), /^BG 1/);
    assert.equal(statuses.get("other"), undefined);
    gate.resolve();
    await tasks.wait("owner", ref.task_id, 1);
    assert.equal(statuses.get("owner"), undefined);
  } finally {
    off.forEach(unsubscribe => unsubscribe());
    gate.resolve();
    await tasks.shutdown();
  }
});
