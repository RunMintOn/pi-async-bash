import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertProcessResult, harness, quote, delay, textOf } from "./support.mjs";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";

async function wireMessages(context) {
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
  return payload.messages;
}

test("completion never wakes the model or adds snapshots, and later requests retain the sent history prefix", { timeout: 15000 }, async (t) => {
  const contexts = [];
  const h = await harness({}, [], { calls(context) { contexts.push(structuredClone(context)); } });
  try {
    await h.runtime.session.prompt("BASELINE");
    const gate = join(h.dir, "release");
    const first = await h.call("start silent completion", {
      command: `printf EARLY; while [ ! -f ${quote(gate)} ]; do sleep 0.02; done; printf LATE; exit 9`,
      yield_time_ms: 250,
    });
    const count = h.requests.length;
    writeFileSync(gate, "");
    await delay(300);
    assert.equal(h.requests.length, count, "process completion started a model request");
    assert(!h.runtime.session.messages.some(message => message.role === "custom"), "completion injected custom context");
    await h.runtime.session.prompt("AFTER_COMPLETION");
    const result = await h.call("read completion", { session_id: first.details.session_id }, "write_stdin");
    assertProcessResult(result.details, { output: "LATE", exit_code: 9 });
    assert(!contexts.some(context => context.messages.some(message =>
      /async-bash-state|Background bash task finished|Task .*log=/.test(textOf(message)))));
    const requests = await Promise.all(contexts.map(wireMessages));
    for (let i = 1; i < requests.length; i++) {
      assert.deepEqual(requests[i].slice(0, requests[i - 1].length), requests[i - 1],
        "a later request rewrote existing provider history");
    }
    const artifact = join(h.dir, "prefix-requests.json");
    writeFileSync(artifact, JSON.stringify(requests, null, 2));
    t.diagnostic("Offline provider payloads: " + artifact);
  } finally { await h.close(); }
});
