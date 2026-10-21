import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { harness, eventOnce, textOf, isTaskState } from "./support.mjs";

async function wireMessages(context) {
  const model = {
    api: "openai-completions", provider: "magpie",
    id: "workbuddy-ai/deepseek-v4.1-flash",
    name: "Offline prefix check", baseUrl: "http://127.0.0.1:1/v1",
    reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 300000, maxTokens: 1000,
    compat: { sendSessionAffinityHeaders: true },
  };
  let payload;
  const reply = await stream(model, context, {
    apiKey: "local-only", maxRetries: 0,
    fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response('data: {"id":"offline","choices":[{"index":0,"delta":{"content":"ACK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
    },
  }).result();
  assert.equal(reply.stopReason, "stop");
  return payload.messages;
}

test("handoff and completion only change the request suffix after existing history", { timeout: 15000 }, async (t) => {
  const contexts = [];
  const h = await harness({}, [], {
    calls(context) { contexts.push(structuredClone(context)); },
  });
  try {
    await h.runtime.session.prompt("BASELINE");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gate = join(h.dir, "finish");
    const ready = eventOnce(h.runtime.session, (e) =>
      e.type === "tool_execution_update" && textOf(e.partialResult).includes("PREFIX_READY"));
    const running = h.call("LONG_TASK", {
      command: `printf PREFIX_READY; while [ ! -f '${gate}' ]; do sleep 0.01; done; printf PREFIX_FINISHED; exit 7`,
    });
    await ready;
    t.mock.timers.tick(63000);
    const result = await running;
    t.mock.timers.reset();
    assert.equal(result.details.status, "running");
    await h.runtime.session.prompt("WHILE_RUNNING");
    const completion = eventOnce(h.runtime.session, (e) =>
      e.type === "agent_settled" && h.runtime.session.messages.some((m) =>
        m.role === "custom" && m.details?.task_id === result.details.task_id));
    writeFileSync(gate, "");
    await completion;
    await h.runtime.session.prompt("AFTER_COMPLETION");

    const requests = await Promise.all(contexts.map(wireMessages));
    const artifact = join(h.dir, "prefix-requests.json");
    writeFileSync(artifact, JSON.stringify(requests, null, 2));
    t.diagnostic(`Provider HTTP payloads (offline): ${artifact}`);
    assert.equal(contexts[1].messages.some(isTaskState), false);
    assert(contexts[2].messages.some(isTaskState), "running task snapshot was lost");
    assert(contexts[3].messages.some(isTaskState), "running task snapshot was lost on the next prompt");
    assert(!contexts.at(-1).messages.some(isTaskState), "visible completion must suppress the obsolete snapshot");
    for (let i = 1; i < requests.length; i++) {
      const previous = requests[i - 1];
      const history = isTaskState(contexts[i - 1].messages.at(-1)) ? previous.slice(0, -1) : previous;
      assert.deepEqual(requests[i].slice(0, history.length), history,
        `request ${i} rewrote previously sent history instead of only its trailing snapshot`);
    }
    const notices = h.runtime.session.messages.filter((m) =>
      m.role === "custom" && m.customType === "async-bash-completion" && m.details?.task_id === result.details.task_id);
    assert.equal(notices.length, 1);
    assert.match(textOf(notices[0]), /exited; exit_code=7/);
  } finally {
    t.mock.timers.reset();
    await h.close();
  }
});

test("compaction and session resume restore current task state only after retained history", { timeout: 15000 }, async (t) => {
  const contexts = [];
  const h = await harness({ compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 1024 } }, [(pi) => {
    pi.on("session_before_compact", (event) => ({
      compaction: {
        summary: "Earlier work was summarized without task details.",
        firstKeptEntryId: event.branchEntries.findLast((e) => e.type === "message" && e.message.role === "user").id,
        tokensBefore: event.preparation.tokensBefore,
      },
    }));
  }], {
    calls(context) { contexts.push(structuredClone(context)); },
  });
  try {
    const gate = join(h.dir, "finish-restored");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ready = eventOnce(h.runtime.session, (e) =>
      e.type === "tool_execution_update" && textOf(e.partialResult).includes("RESTORE_READY"));
    const running = h.call("START_RESTORED_TASK", {
      command: `printf RESTORE_READY; while [ ! -f '${gate}' ]; do sleep 0.01; done; exit 9`,
    });
    await ready;
    t.mock.timers.tick(63000);
    const result = await running;
    t.mock.timers.reset();
    const id = result.details.task_id;
    await h.runtime.session.prompt("KEEP_AFTER_COMPACTION");
    await h.runtime.session.compact();
    assert(!h.runtime.session.messages.some((m) => m.role === "toolResult" && m.details?.task_id === id),
      "compaction must actually remove the original task result");
    await h.runtime.session.prompt("STATE_AFTER_COMPACTION");
    const compacted = contexts.at(-1);
    assert(isTaskState(compacted.messages.at(-1)));
    assert.match(textOf(compacted.messages.at(-1)), new RegExp(`Task ${id}: running;`));
    assert.equal(textOf(compacted.messages.at(-2)), "STATE_AFTER_COMPACTION");

    const ownerFile = h.runtime.session.sessionFile;
    await h.runtime.newSession();
    const record = join(h.dir, "agent", "extension-data", "async-bash", `${id}.json`);
    await h.call("FINISH_WHILE_AWAY", {
      command: `touch '${gate}'; while ! grep -q '"status":"exited"' '${record}'; do sleep 0.01; done`,
      timeout: 3,
    });
    assert(!h.runtime.session.messages.some((m) => m.role === "custom" && m.details?.task_id === id),
      "another session must not receive the owner's completion");
    await h.runtime.switchSession(ownerFile);
    await h.runtime.session.prompt("STATE_AFTER_RESUME");
    const resumed = contexts.at(-1);
    assert(isTaskState(resumed.messages.at(-1)));
    assert.match(textOf(resumed.messages.at(-1)), new RegExp(`Task ${id}: exited; exit_code=9;`));
    assert.equal(textOf(resumed.messages.at(-2)), "STATE_AFTER_RESUME");
    assert(!h.runtime.session.messages.some((m) => m.role === "custom" && m.customType === "async-bash-completion"),
      "restoration must not automatically replay completion");
    const compactedWire = await wireMessages(compacted);
    const resumedWire = await wireMessages(resumed);
    assert.deepEqual(resumedWire.slice(0, compactedWire.length - 1), compactedWire.slice(0, -1),
      "restoring a changed task state rewrote the compacted history");
    const artifact = join(h.dir, "restored-prefix-requests.json");
    writeFileSync(artifact, JSON.stringify([compactedWire, resumedWire], null, 2));
    t.diagnostic(`Restored provider HTTP payloads (offline): ${artifact}`);
  } finally {
    t.mock.timers.reset();
    await h.close();
  }
});
