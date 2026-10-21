// Opt-in live-model check. Makes network requests using existing credentials.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const sourceAgentDir = getAgentDir();
const dir = mkdtempSync(join(tmpdir(), "pi-async-model-wait-"));
const provider = process.env.PROBE_PROVIDER ?? "magpie";
const modelId = process.env.PROBE_MODEL ?? "workbuddy-ai/deepseek-v4.1-flash";
const modelRuntime = await ModelRuntime.create({
  authPath: join(sourceAgentDir, "auth.json"),
  modelsPath: join(sourceAgentDir, "models.json"),
  refreshOnCreate: false,
});
const model = modelRuntime.getModel(provider, modelId);
assert(model, `Model unavailable: ${provider}/${modelId}`);
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
writeFileSync(join(dir, "fixture.mjs"), `
import { appendFileSync } from "node:fs";
appendFileSync("starts.log", "started\\n");
console.log("fixture started");
setTimeout(() => { console.log("E2E_SENTINEL_DONE"); process.exit(7); }, 66000);
`);
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
});
const resourceLoader = new DefaultResourceLoader({
  cwd: dir, agentDir: join(dir, "agent"), settingsManager,
  noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
  additionalExtensionPaths: [resolve("index.ts")],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
const { session } = await createAgentSession({
  cwd: dir, agentDir: join(dir, "agent"), modelRuntime, model, thinkingLevel: "off",
  settingsManager, resourceLoader, tools: ["bash", "bash_task"],
  sessionManager: SessionManager.create(dir, join(dir, "sessions")),
});
const calls = [];
const notices = [];
const textOf = (m) => typeof m.content === "string" ? m.content :
  (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
let resolveDone, rejectDone;
const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
const deadline = setTimeout(() => rejectDone(new Error("No automatic completion within 150 seconds")), 150000);
const off = session.subscribe((event) => {
  if (["message_end", "agent_settled", "tool_execution_start"].includes(event.type)) {
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ observed_at: Date.now(), ...event }) + "\n");
  }
  if (event.type === "tool_execution_start") {
    calls.push({ name: event.toolName, args: event.args });
    if (calls.length > 8) rejectDone(new Error("Tool-call budget exceeded"));
  }
  if (event.type === "message_end" && event.message.role === "custom" &&
    event.message.customType === "async-bash-completion") {
    notices.push({ at: Date.now(), message: event.message });
  }
  if (event.type === "agent_settled" && notices.length) resolveDone();
});
console.log(`Artifacts: ${dir}`);
try {
  await session.bindExtensions({});
  const prompt = "运行 node fixture.mjs。完成后告诉我它的退出码和最后输出。";
  writeFileSync(join(dir, "prompt.txt"), prompt);
  // This is the only user prompt; completion must resume the session by itself.
  await Promise.race([session.prompt(prompt).then(() => done), done]);
  const final = session.getLastAssistantText();
  const starts = readFileSync(join(dir, "starts.log"), "utf8").trim().split("\n").length;
  const waitingCalls = calls.filter((c) => c.name === "bash_task" ||
    /\b(?:nohup|sleep|tail|pgrep)\b|&(?:\s|$)/.test(c.args?.command ?? ""));
  const summary = {
    provider, model: modelId, starts, calls,
    task_id: notices[0]?.message.details?.task_id,
    completion_lag_ms: notices[0] ? notices[0].at - notices[0].message.details.finished_at : null,
    notifications: notices.length, waiting_calls: waitingCalls.length, final,
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(starts, 1, "fixture was restarted");
  assert.equal(notices.length, 1, "missing or duplicate completion");
  assert.equal(waitingCalls.length, 0, "model manufactured a wait or polled status");
  assert.match(final, /7/);
  assert.match(final, /E2E_SENTINEL_DONE/);
} finally {
  clearTimeout(deadline);
  off();
  await session.abort();
  session.dispose();
}
