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
      const last = context.messages.at(-1)!;
      const text = typeof last.content === "string" ? last.content :
        last.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const user = context.messages.findLast(m => m.role === "user");
      const userText = typeof user?.content === "string" ? user.content :
        user?.content.filter(c => c.type === "text").map(c => c.text).join("\n") ?? "";
      const session = text.match(/Process running with session ID (\d+)/)?.[1];
      const calls = last.role === "user" && text.startsWith("CALL ") ? JSON.parse(text.slice(5)) :
        last.role === "user" && text.startsWith("RUN ") ? [{ name: "bash", args: JSON.parse(text.slice(4)) }] :
        last.role === "toolResult" && userText.startsWith("RUN ") && session ?
          [{ name: "write_stdin", args: { session_id: Number(session), yield_time_ms: 300000 } }] : [];
      const message = {
        role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
        content: calls.length ? calls.map((call: { name: string; args: object }) => ({
          type: "toolCall" as const, id: `call-${++sequence}`, name: call.name, arguments: call.args,
        })) : [{ type: "text" as const, text: `ACK ${text.slice(0, 500)}` }],
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
