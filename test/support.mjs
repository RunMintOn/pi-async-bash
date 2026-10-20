import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
export const pi = await import(pathToFileURL(join(packageRoot, "dist/index.js")));
export const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
export const extensionPath = resolve("index.ts");
export const textOf = (m) => typeof m.content === "string" ? m.content :
  (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function eventOnce(session, predicate, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("Session event deadline")); }, timeout);
    const off = session.subscribe((event) => {
      if (predicate(event)) { clearTimeout(timer); off(); resolve(event); }
    });
  });
}

export async function harness(settings = {}, extensionFactories = [], options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-async-test-"));
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  const commands = new Map();
  const requests = [];
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  let seq = 0;
  modelRuntime.registerProvider("local-test", {
    api: "local-test-api", apiKey: "local-only", baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "scripted", name: "Local test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 1000,
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const texts = context.messages.map(textOf);
      requests.push({ at: Date.now(), texts });
      const last = context.messages.at(-1);
      const request = last.role === "user" ? commands.get(textOf(last)) : undefined;
      const calls = request ? (Array.isArray(request) ? request : [request]) : [];
      const msg = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: calls.length ? calls.map((c) => ({
          type: "toolCall", id: `call-${++seq}`, name: c.name ?? "bash", arguments: c.args ?? c,
        })) : [{ type: "text", text: `ACK ${textOf(last).slice(0, 300)}` }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: calls.length ? "toolUse" : "stop", timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...msg, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: msg.stopReason, message: msg });
      stream.end();
      return stream;
    },
  });
  const model = modelRuntime.getModel("local-test", "scripted");
  async function factory({ sessionManager, sessionStartEvent }) {
    const settingsManager = pi.SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", ...settings,
    });
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: dir, agentDir: join(dir, "agent"), settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
      additionalExtensionPaths: options.extensionPaths ?? [extensionPath],
      extensionFactories,
    });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
    const services = { cwd: dir, agentDir: join(dir, "agent"), settingsManager, resourceLoader, modelRuntime, diagnostics: [] };
    const result = await pi.createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent, model, thinkingLevel: "off",
      tools: options.tools ?? ["bash", "bash_task"],
    });
    return { ...result, services, diagnostics: [] };
  }
  const runtime = await pi.createAgentSessionRuntime(factory, {
    cwd: dir, agentDir: join(dir, "agent"), sessionManager: pi.SessionManager.create(dir, join(dir, "sessions")),
  });
  runtime.setRebindSession((s) => s.bindExtensions(options.binding ?? {}));
  await runtime.session.bindExtensions(options.binding ?? {});
  return {
    dir, runtime, commands, requests,
    async call(text, args, name = "bash") {
      commands.set(text, { name, args });
      await runtime.session.prompt(text);
      return runtime.session.messages.filter((m) => m.role === "toolResult").at(-1);
    },
    close: () => runtime.dispose(),
  };
}
