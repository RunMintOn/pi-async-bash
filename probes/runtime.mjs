// Investigation harness, not a distributable extension. All model responses are local.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";

const root = process.env.PI_PACKAGE_ROOT ??
  "/Users/ziqian/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent";
const load = (p) => import(pathToFileURL(p));
const pi = await load(join(root, "dist/index.js"));
const { createBashToolDefinition } = await load(join(root, "dist/core/tools/bash.js"));
const { killProcessTree } = await load(join(root, "dist/utils/shell.js"));
const { truncateTail } = await load(join(root, "dist/core/tools/truncate.js"));
const { Type } = await load(join(dirname(dirname(root)), "typebox/build/index.mjs"));
const { createAssistantMessageEventStream } = await load(join(dirname(root), "pi-ai/dist/utils/event-stream.js"));
const dir = mkdtempSync(join(tmpdir(), "pi-async-investigation-"));
const timeline = [];
const requests = [];
const commands = new Map();
const jobs = new Map();
const apis = [];
let active;
let sequence = 0;
let runtime;
const mark = (type, data = {}) => timeline.push({ at: performance.now(), type, ...data });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (m) => typeof m.content === "string" ? m.content :
  (m.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
const resultText = (r) => textOf(r);
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const checks = [];
function check(name, data) {
  checks.push({ name, ...data });
  console.log(JSON.stringify({ check: name, ...data }));
}
function waitEvent(session, predicate) {
  return new Promise((resolve) => {
    const unsub = session.subscribe((event) => {
      if (predicate(event)) { unsub(); resolve(event); }
    });
  });
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("probe deadline")), 8000); }),
    ]);
  } finally { clearTimeout(timer); }
}

const modelRuntime = await pi.ModelRuntime.create({
  authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false,
});
modelRuntime.registerProvider("local-investigation", {
  api: "local-investigation-api", apiKey: "local-only", baseUrl: "http://127.0.0.1:1",
  models: [{
    id: "scripted", name: "Scripted, no network", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000, maxTokens: 1000,
  }],
  streamSimple(model, context) {
    const stream = createAssistantMessageEventStream();
    const last = context.messages.at(-1);
    const text = textOf(last);
    requests.push({ session: active?.owner, text, state: context.messages.map(textOf).filter((s) => s.startsWith("JOB_STATE")) });
    mark("request", { text });
    const command = last.role === "user" ? commands.get(text) : undefined;
    const message = {
      role: "assistant", provider: model.provider, api: model.api, model: model.id,
      content: command
        ? [{ type: "toolCall", id: `call-${++sequence}`, name: "bash", arguments: command }]
        : [{ type: "text", text: `ACK ${text.slice(0, 160)}` }],
      usage, stopReason: command ? "toolUse" : "stop", timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end();
    return stream;
  },
});
const model = modelRuntime.getModel("local-investigation", "scripted");
assert(model);

function notification(job) {
  return `JOB_DONE ${job.id} code=${job.code} signal=${job.signal}`;
}
function localExtension(api) {
  apis.push(api);
  api.on("session_start", (_event, ctx) => {
    active = { owner: ctx.sessionManager.getSessionId(), api };
  });
  api.on("session_shutdown", () => { active = undefined; });
  api.on("context", (event, ctx) => {
    const owner = ctx.sessionManager.getSessionId();
    const visibleIds = new Set(event.messages.filter((m) => m.role === "toolResult").map((m) => m.details?.job_id));
    const extra = [...jobs.values()].filter((j) =>
      j.code !== undefined && (j.owner === owner || visibleIds.has(j.id)) &&
      !event.messages.some((m) => m.role === "custom" && m.details?.job_id === j.id));
    return {
      messages: [...event.messages, ...extra.map((j) => ({
        role: "custom", customType: "probe-state", content: `JOB_STATE ${j.id} code=${j.code}`,
        display: false, details: { job_id: j.id }, timestamp: Date.now(),
      }))],
    };
  });
  const builtin = createBashToolDefinition(dir);
  api.registerTool({
    ...builtin,
    parameters: Type.Object({
      command: Type.String(), timeout: Type.Optional(Type.Number()),
      background: Type.Optional(Type.Boolean()),
    }),
    async execute(id, args, signal, update, ctx) {
      if (!args.background) return builtin.execute(id, args, signal, update, ctx);
      assert.equal(args.timeout, undefined, "background timeout is outside this minimal probe");
      const jobId = `j${jobs.size + 1}`;
      const log = join(dir, `${jobId}.log`);
      const fd = openSync(log, "w");
      let child;
      try {
        child = spawn("/bin/bash", ["-c", args.command], {
          cwd: dir, detached: true, stdio: ["ignore", fd, fd],
        });
      } finally { closeSync(fd); }
      const job = { id: jobId, owner: ctx.sessionManager.getSessionId(), child, log };
      jobs.set(jobId, job);
      job.done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          Object.assign(job, { code, signal });
          mark("job_exit", { id: jobId, code, signal });
          if (active?.owner === job.owner) {
            active.api.sendMessage({
              customType: "probe-done", content: notification(job), display: true,
              details: { job_id: job.id },
            }, { triggerTurn: true, deliverAs: "followUp" });
          }
          resolve(job);
        });
      });
      await once(child, "spawn");
      child.unref();
      mark("job_started", { id: jobId, pid: child.pid });
      return {
        content: [{ type: "text", text: `Started ${jobId}. Log: ${log}` }],
        details: { job_id: jobId, owner: job.owner },
      };
    },
  });
}

async function factory({ sessionManager, sessionStartEvent }) {
  const settingsManager = pi.SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
    cacheWarming: { mode: "off" },
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, "agent"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, extensionFactories: [localExtension],
  });
  await resourceLoader.reload();
  const services = { cwd: dir, agentDir: join(dir, "agent"), modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
  const result = await pi.createAgentSessionFromServices({
    services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", tools: ["bash"],
  });
  return { ...result, services, diagnostics: [] };
}

try {
  runtime = await pi.createAgentSessionRuntime(factory, {
    cwd: dir, agentDir: join(dir, "agent"), sessionManager: pi.SessionManager.create(dir, join(dir, "sessions")),
  });
  runtime.setRebindSession(async (s) => {
    await s.bindExtensions({});
    s.subscribe((e) => {
      if (e.type === "message_end") mark("message_end", { role: e.message.role, text: textOf(e.message) });
    });
  });
  await runtime.session.bindExtensions({});
  const original = createBashToolDefinition(dir);

  // A user can submit steering during a foreground call, but it is not persisted until the batch finishes.
  commands.set("RUN_FG", { command: "sleep 0.6; printf foreground" });
  let session = runtime.session;
  const toolStarted = waitEvent(session, (e) => e.type === "tool_execution_start");
  const foreground = session.prompt("RUN_FG");
  await bounded(toolStarted);
  await session.steer("USER_DURING_FG");
  const during = session.sessionManager.getBranch().some((e) => e.message?.role === "user" && textOf(e.message).includes("USER_DURING_FG"));
  assert.equal(during, false);
  await foreground;
  assert(session.messages.some((m) => m.role === "user" && textOf(m).includes("USER_DURING_FG")));
  check("foreground_steering", { accepted_while_running: true, persisted_while_running: during, persisted_after: true });

  for (const [name, command, exit] of [
    ["success", "printf 'out\\n'; printf 'err\\n' >&2", 0],
    ["failure", "printf failed; exit 9", 9],
  ]) {
    const expected = await original.execute("baseline", { command });
    commands.set(`RUN_${name}`, { command });
    await session.prompt(`RUN_${name}`);
    const actual = session.messages.filter((m) => m.role === "toolResult").at(-1);
    assert.equal(resultText(actual), resultText(expected));
    assert.equal(actual.isError, exit !== 0);
    check(`foreground_${name}`, { output_matches_builtin: true, exit_code: exit, isError: actual.isError });
  }
  const input = await original.execute("stdin", { command: "read x; printf 'read_status=%s' \"$?\"" });
  assert.equal(resultText(input), "read_status=1");
  check("stdin", { output: resultText(input) });
  await assert.rejects(original.execute("timeout", { command: "printf before; sleep 2", timeout: 0.08 }), /before[\s\S]*timed out/);
  const controller = new AbortController();
  const aborted = original.execute("abort", { command: "printf before; sleep 2" }, controller.signal);
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(aborted, /before[\s\S]*Command aborted/);
  check("foreground_timeout_abort", { partial_output_preserved: true, timeout_rejected: true, abort_rejected: true });

  // A real process outlives the starting turn, and another user request is processed before it exits.
  commands.set("RUN_BG", { command: "sleep 1; printf background-failure; exit 7", background: true });
  await session.prompt("RUN_BG");
  const job = [...jobs.values()].at(-1);
  assert.equal(job.code, undefined);
  const doneTurn = waitEvent(session, (e) => e.type === "agent_settled" && job.code !== undefined);
  await session.prompt("USER_DURING_BG");
  assert.equal(job.code, undefined);
  const userRequest = timeline.findLast((e) => e.type === "request" && e.text === "USER_DURING_BG");
  await bounded(job.done);
  await bounded(doneTurn);
  assert.equal(job.code, 7);
  assert.equal(readFileSync(job.log, "utf8"), "background-failure");
  assert(userRequest.at < timeline.find((e) => e.type === "job_exit" && e.id === job.id).at);
  const notifications = session.messages.filter((m) => m.role === "custom" && m.details?.job_id === job.id);
  assert.equal(notifications.length, 1);
  check("background_conversation_and_failure", { user_processed_before_exit: true, exit_code: job.code, notifications: notifications.length });

  commands.set("RUN_BG_OK", { command: "sleep 0.15; printf background-success", background: true });
  await session.prompt("RUN_BG_OK");
  const okJob = [...jobs.values()].at(-1);
  const okSettled = waitEvent(session, (e) => e.type === "agent_settled" && okJob.code !== undefined);
  await bounded(okJob.done);
  await bounded(okSettled);
  assert.equal(okJob.code, 0);
  const successNotifications = session.messages.filter((m) => m.role === "custom" && m.details?.job_id === okJob.id).length;
  assert.equal(successNotifications, 1);
  check("background_success", { exit_code: okJob.code, notifications: successNotifications });

  // Switch away before completion. Retaining an old ExtensionAPI is invalid.
  commands.set("RUN_SWITCH", { command: "sleep 0.5; printf switched; exit 3", background: true });
  await session.prompt("RUN_SWITCH");
  const switched = [...jobs.values()].at(-1);
  const owner = session.sessionId;
  const ownerFile = session.sessionFile;
  const oldApi = apis.at(-1);
  await runtime.newSession();
  const newSession = runtime.session;
  assert.notEqual(newSession.sessionId, owner);
  assert.throws(() => oldApi.sendMessage({ customType: "stale", content: "bad", display: true }), /stale/);
  await bounded(switched.done);
  assert(!newSession.messages.some((m) => textOf(m).includes(switched.id)));
  const beforeResumeRequests = requests.length;
  await runtime.switchSession(ownerFile);
  session = runtime.session;
  await sleep(25);
  assert.equal(requests.length, beforeResumeRequests);
  await session.prompt("USER_AFTER_RESUME");
  assert(requests.at(-1).state.some((s) => s.includes(switched.id) && s.includes("code=3")));
  check("switch_resume", { stale_api_rejected: true, wrong_session_not_notified: true, state_visible_on_next_request: true });

  const beforeTreeRequests = requests.length;
  const beforeTreeOwner = session.sessionId;
  const startedEntry = session.sessionManager.getEntries().find((e) =>
    e.type === "message" && e.message.role === "toolResult" && e.message.details?.job_id === job.id);
  assert(startedEntry);
  await session.navigateTree(startedEntry.id, { summarize: false });
  await sleep(25);
  assert.equal(requests.length, beforeTreeRequests);
  assert.equal(session.sessionId, beforeTreeOwner);
  assert(!session.messages.some((m) => m.role === "custom" && m.details?.job_id === job.id));
  await session.prompt("USER_AFTER_TREE");
  assert(requests.at(-1).state.some((s) => s.includes(`${job.id} code=7`)));
  check("tree", { same_session_id: true, no_automatic_replay_turn: true, state_visible_without_copying_notification: true });

  // /fork creates a new session; inherited job handles must retain the original owner.
  const leaf = session.sessionManager.getLeafId();
  await runtime.fork(leaf, { position: "at" });
  assert.notEqual(runtime.session.sessionId, owner);
  await runtime.session.prompt("USER_AFTER_FORK");
  assert(requests.at(-1).state.some((s) => s.includes(`${job.id} code=7`)));
  check("fork", { new_session_id: true, inherited_job_state_visible: true, owner_unchanged: job.owner === owner });

  const hugeLine = "中".repeat(100000);
  const boundedTail = truncateTail(hugeLine, { maxLines: 100, maxBytes: 16384 });
  assert(Buffer.byteLength(boundedTail.content) <= 16384);
  assert.equal(hugeLine.split("\n").slice(-100).join("\n").length, hugeLine.length);
  check("tail_budget", { line_only_bytes: Buffer.byteLength(hugeLine), bounded_bytes: Buffer.byteLength(boundedTail.content) });

  // Node detached already creates a POSIX session. No setsid executable is required.
  const detached = spawn("/bin/bash", ["-c", "sleep 2"], { detached: true, stdio: "ignore" });
  await once(detached, "spawn");
  try {
    const ps = spawnSync("python3", ["-c",
      "import os,sys,json; p=int(sys.argv[1]); print(json.dumps(dict(pid=p,pgid=os.getpgid(p),sid=os.getsid(p))))",
      String(detached.pid)], { encoding: "utf8" });
    assert.equal(ps.status, 0, ps.stderr);
    const identity = JSON.parse(ps.stdout);
    assert.equal(identity.pgid, detached.pid);
    assert.equal(identity.sid, detached.pid);
    check("detached_process_group", { ...identity, setsid_executable: spawnSync("which", ["setsid"]).status === 0 });
  } finally { killProcessTree(detached.pid); await once(detached, "exit"); }

  console.log(JSON.stringify({ passed: checks.length, artifact_directory: dir, checks, timeline }, null, 2));
} finally {
  for (const j of jobs.values()) if (j.code === undefined) killProcessTree(j.child.pid);
  if (runtime) await runtime.dispose();
}
