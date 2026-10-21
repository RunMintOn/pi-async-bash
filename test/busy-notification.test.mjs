import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { harness, eventOnce, textOf } from "./support.mjs";

test("completion reaches the next model request while the agent keeps using tools", { timeout: 10000 }, async (t) => {
  const h = await harness({}, [], {
    calls(context) {
      const last = context.messages.at(-1);
      const canContinue = last?.role === "toolResult" || textOf(last).includes("Background bash task finished.");
      const previous = context.messages.findLast((m) => m.role === "toolResult" && /^STEP_\d+$/.test(textOf(m)));
      const step = canContinue && previous && /^STEP_(\d+)$/.exec(textOf(previous));
      return step && Number(step[1]) < 4
        ? [{ name: "bash", args: { command: `printf STEP_${Number(step[1]) + 1}` } }]
        : undefined;
    },
  });
  try {
    const gate = join(h.dir, "release");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ready = eventOnce(h.runtime.session, (e) =>
      e.type === "tool_execution_update" && textOf(e.partialResult).includes("BACKGROUND_READY"));
    const running = h.call("start background", {
      command: `printf BACKGROUND_READY; while [ ! -f '${gate}' ]; do sleep 0.01; done; printf FINISHED; exit 7`,
    });
    await ready;
    t.mock.timers.tick(63000);
    const result = await running;
    t.mock.timers.reset();
    const id = result.details.task_id;
    assert.equal(result.details.status, "running");
    const record = join(h.dir, "agent", "extension-data", "async-bash", `${id}.json`);
    const before = h.requests.length;
    await h.call("keep working", {
      command: `touch '${gate}'; while ! grep -q '"status":"exited"' '${record}'; do sleep 0.01; done; printf STEP_1`,
      timeout: 3,
    });
    const requests = h.requests.slice(before);
    const afterFirstTool = requests.find((r) => r.texts.includes("STEP_1"));
    assert(afterFirstTool, "the independent tool never completed");
    assert(afterFirstTool.texts.some((s) => s.includes("Background bash task finished.") && s.includes(`Task ${id}: exited; exit_code=7`)),
      "completion was withheld until the agent stopped its tool loop");
    const notices = h.runtime.session.messages.filter((m) =>
      m.role === "custom" && m.customType === "async-bash-completion" && m.details?.task_id === id);
    assert.equal(notices.length, 1);
    assert(h.runtime.session.messages.some((m) => m.role === "toolResult" && textOf(m) === "STEP_4"),
      "the independent tool loop did not finish");
    t.diagnostic(`Completion entered the conversation ${notices[0].timestamp - notices[0].details.finished_at}ms after task exit`);
  } finally {
    t.mock.timers.reset();
    await h.close();
  }
});
