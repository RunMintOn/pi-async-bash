import assert from "node:assert/strict";
import test from "node:test";
import { harness, eventOnce, textOf } from "./support.mjs";

test("a handed-off task notifies its owner and continues the agent", { timeout: 42000 }, async () => {
  const h = await harness();
  try {
    const result = await h.call("long notification", { command: "printf first; sleep 31; printf finished; exit 9" });
    const id = result.details?.task_id;
    assert.equal(typeof id, "string");
    const notified = eventOnce(h.runtime.session, (e) =>
      e.type === "message_end" && e.message.role === "custom" && e.message.details?.task_id === id, 5000);
    const settled = eventOnce(h.runtime.session, (e) =>
      e.type === "agent_settled" && h.runtime.session.messages.some((m) => m.role === "custom"), 5000);
    const completion = Promise.all([notified, settled]);
    await h.runtime.session.prompt("USER_WHILE_TASK_RUNNING");
    const [event] = await completion;
    assert.match(textOf(event.message), /exited.*exit_code=9/);
    assert(h.requests.some((r) => r.texts.some((s) => s.includes(`Task ${id}: exited`))));
    assert.equal(h.runtime.session.messages.filter((m) => m.role === "custom" && m.details?.task_id === id).length, 1);
  } finally { await h.close(); }
});
