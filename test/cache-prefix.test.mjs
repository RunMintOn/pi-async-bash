import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, quote, delay, eventOnce, textOf } from "./support.mjs";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";

async function wireRequest(context) {
  const model = {
    api: "openai-completions", provider: "offline", id: "prefix-check", name: "Offline prefix check",
    baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000,
  };
  let payload;
  await stream(model, context, {
    apiKey: "local-only", maxRetries: 0,
    fetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response('data: {"id":"offline","choices":[{"index":0,"delta":{"content":"ACK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
    },
  }).result();
  return payload;
}

test("idle wake and busy completion preserve the OpenAI adapter's serialized prompt prefix and tools", { timeout: 55000 }, async (t) => {
  const contexts = [];
  const h = await harness({}, [], {
    binding: { mode: "rpc" },
    calls(context) { contexts.push(structuredClone(context)); },
  });
  try {
    await h.runtime.session.prompt("BASELINE");
    const idleGate = join(h.dir, "idle");
    const busyGate = join(h.dir, "busy");
    const blockGate = join(h.dir, "block");
    const gated = (gate, out) => `while [ ! -f ${quote(gate)} ]; do sleep 0.02; done; printf ${out}`;
    h.commands.set("START_BOTH", [idleGate, busyGate].map((gate, i) => ({
      name: "bash", args: { command: gated(gate, i === 0 ? "IDLE_DONE" : "BUSY_DONE") },
    })));
    await h.runtime.session.prompt("START_BOTH");
    const session = h.runtime.session;
    const idleSettled = eventOnce(session, event => event.type === "agent_settled");
    writeFileSync(idleGate, "");
    await idleSettled;
    assert.match(textOf(session.messages.at(-1)), /IDLE_DONE/);

    h.commands.set("KEEP_AGENT_BUSY", { command: `printf BLOCK_STARTED; ${gated(blockGate, "BLOCK_DONE")}` });
    const blockStarted = eventOnce(session, event =>
      event.type === "tool_execution_update" && textOf(event.partialResult).includes("BLOCK_STARTED"));
    const inProgress = session.prompt("KEEP_AGENT_BUSY");
    await blockStarted;
    const before = contexts.length;
    writeFileSync(busyGate, "");
    await delay(120);
    assert.equal(contexts.length, before, "completion interrupted a busy tool");
    writeFileSync(blockGate, "");
    await inProgress;
    assert.match(textOf(session.messages.at(-1)), /BUSY_DONE/);
    const completions = session.messages.filter(m => m.role === "custom" && m.customType === "async-bash-completion");
    assert.equal(completions.length, 2);

    const requests = await Promise.all(contexts.map(wireRequest));
    for (let i = 1; i < requests.length; i++) {
      const previous = requests[i - 1];
      assert.deepEqual(requests[i].messages.slice(0, previous.messages.length), previous.messages,
        "a later request rewrote existing provider history");
      assert.deepEqual(requests[i].tools, previous.tools, "task status changed the serialized tool definitions");
    }
    const artifact = join(h.dir, "prefix-requests.json");
    writeFileSync(artifact, JSON.stringify(requests, null, 2));
    t.diagnostic("Offline provider payloads: " + artifact);
  } finally { await h.close(); }
});
