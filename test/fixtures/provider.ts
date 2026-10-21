import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// A deterministic provider for the actual CLI/RPC process. Never makes network requests.
export default function localProvider(pi: ExtensionAPI) {
  let sequence = 0;
  pi.registerProvider("async-test", {
    api: "async-test-api", apiKey: "local-only", baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "scripted", name: "Local test", input: ["text"], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 1000,
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.findLast((m) => {
        const text = typeof m.content === "string" ? m.content :
          m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        return m.role !== "user" || !/^Task [\da-f-]+: \w+; exit_code=.*; log=/.test(text);
      })!;
      const text = typeof last.content === "string" ? last.content :
        last.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const calls = last.role === "user" && text.startsWith("CALL ") ? JSON.parse(text.slice(5)) : [];
      const state = text.startsWith("STATE_") ? context.messages
        .filter((m) => m.role === "user")
        .map((m) => typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"))
        .filter((s) => s.startsWith("Task ")).join("\n") : "";
      const message = {
        role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
        content: calls.length ? calls.map((call: { name: string; args: object }) => ({
          type: "toolCall" as const, id: `call-${++sequence}`, name: call.name, arguments: call.args,
        })) : [{ type: "text" as const, text: state || `ACK ${text.slice(0, 500)}` }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: calls.length ? "toolUse" as const : "stop" as const, timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  });
  pi.registerCommand("test-reload", {
    description: "Reload for lifecycle tests",
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
  pi.registerCommand("test-tree", {
    description: "Navigate without an LLM summary",
    handler: async (id, ctx) => { await ctx.navigateTree(id, { summarize: false }); },
  });
}
