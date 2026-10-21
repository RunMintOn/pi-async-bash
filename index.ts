import { join } from "node:path";
import { Type } from "typebox";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { eventId, getManager, type TaskRecord } from "./src/tasks.ts";
import { installTaskStatus, taskReferences } from "./src/status.ts";

function details(value: unknown): { task_id?: string; task_event_id?: string } {
  return value && typeof value === "object" ? value : {};
}

export default function asyncBash(pi: ExtensionAPI) {
  const definition = createBashToolDefinition(process.cwd());
  const manager = getManager(join(getAgentDir(), "extension-data", "async-bash"));
  const taskSchema = Type.Object({
    task_id: Type.String(), status: Type.String(), log_path: Type.String(),
    exit_code: Type.Union([Type.Number(), Type.Null()]), wall_time_seconds: Type.Number(),
  }, { additionalProperties: true });
  pi.registerTool<typeof definition.parameters, unknown>({
    ...definition,
    renderResult: undefined,
    description: definition.description + " After 63 seconds, returns a running task instead of waiting. Completion is notified automatically. For tasks whose results you need, run the actual command directly and let this tool handle the background handoff. Do not detach it with a trailing & or create sleep-and-poll loops to wait for completion.",
    outputSchema: Type.Union([definition.outputSchema!, taskSchema]),
    execute(id, input, signal, update, ctx) {
      const settings = pi.getSettings();
      const operations = createLocalBashOperations({ shellPath: settings.shellPath });
      let foreground = true;
      return manager.execute({
        owner: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, timeout: input.timeout, signal,
        run: (taskSignal, log, started) => createBashToolDefinition(ctx.cwd, {
          shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix,
          operations: {
            exec(command, cwd, options) {
              started();
              return operations.exec(command, cwd, {
                ...options,
                onData(data) { log(data); options.onData(data); },
              });
            },
          },
        }).execute(id, input, taskSignal, (value) => { if (foreground) update?.(value); }, ctx),
      }).then((result) => {
        const id = details(result.details).task_id;
        // Nested codemode results are not transcript toolResults; persist the reference on the branch too.
        if (id) pi.appendEntry("async-bash-task", { task_id: id });
        return result;
      }).finally(() => { foreground = false; });
    },
  });
  pi.registerTool({
    name: "bash_task",
    label: "bash task",
    description: "Inspect or kill a bash task. Completion is notified automatically.",
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID returned by bash" }),
      action: Type.Union([Type.Literal("status"), Type.Literal("kill")]),
    }),
    outputSchema: taskSchema,
    execute: (_id, args, signal) => manager.control(args.task_id, args.action, signal),
  });
  let unbind = () => {};
  pi.on("session_start", (_event, ctx) => {
    unbind();
    const disposeStatus = installTaskStatus(pi, ctx, manager);
    const owner = ctx.sessionManager.getSessionId();
    let active = true;
    const queued = new Set<string>();
    const seen = new Set<string>();
    const pending = new Map<string, TaskRecord>();
    for (const entry of ctx.sessionManager.getEntries()) {
      const data = entry.type === "custom_message" ? details(entry.details) :
        entry.type === "message" && entry.message.role === "toolResult" ? details(entry.message.details) : {};
      if (data.task_event_id) seen.add(data.task_event_id);
    }
    const flush = (atTurnBoundary = false) => {
      if (!active || (!atTurnBoundary && !ctx.isIdle())) return;
      for (const [id, record] of pending) {
        if (seen.has(id) || queued.has(id)) { pending.delete(id); continue; }
        try {
          const result = manager.describe(record);
          queued.add(id);
          // Follow-ups wait for the agent to stop; results must also reach active tool loops.
          pi.sendMessage({
            customType: "async-bash-completion", content: [
              { type: "text", text: "Background bash task finished. Use the result below to continue any dependent work." },
              ...result.content,
            ],
            display: true, details: result.details,
          }, { triggerTurn: true, deliverAs: "steer" });
          pending.delete(id);
        } catch {
          queued.delete(id);
          // The persisted terminal state remains available to context/status if delivery fails.
        }
      }
    };
    const unsubscribe = manager.subscribe((record: TaskRecord) => {
      if (record.owner_session_id !== owner) return;
      const id = eventId(record);
      if (seen.has(id) || queued.has(id)) return;
      pending.set(id, record);
      setImmediate(() => flush());
    });
    const offMessage = pi.on("message_end", (event) => {
      const message = event.message;
      const data = message.role === "custom" || message.role === "toolResult" ? details(message.details) : {};
      if (data.task_event_id) {
        seen.add(data.task_event_id);
        pending.delete(data.task_event_id);
      }
    });
    // Task results must reach the transcript before deciding whether another turn is necessary.
    const offTurn = pi.on("turn_end", () => flush(true));
    const offSettled = pi.on("agent_before_settle", () => flush(true));
    unbind = () => { active = false; disposeStatus(); unsubscribe(); offMessage(); offTurn(); offSettled(); };
  });
  pi.on("context", (event, ctx) => {
    const references = taskReferences(ctx.sessionManager.getBranch());
    const visible = new Set(event.messages.flatMap((m) => {
      const id = m.role === "custom" || m.role === "toolResult" ? details(m.details).task_event_id : undefined;
      return id ? [id] : [];
    }));
    const summaries: string[] = [];
    let bytes = 0;
    for (const task of manager.forSession(ctx.sessionManager.getSessionId(), references)) {
      if (task.status !== "running" && visible.has(eventId(task))) continue;
      const line = `Task ${task.task_id}: ${task.status}; exit_code=${task.exit_code}; log=${task.log_path}`;
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > 16384) break;
      summaries.push(line);
      bytes += size;
    }
    if (!summaries.length) return;
    return { messages: [{
      role: "custom" as const, customType: "async-bash-state",
      content: summaries.join("\n"), display: false, timestamp: Date.now(),
    }, ...event.messages] };
  });
  pi.on("session_shutdown", async (event) => {
    unbind();
    if (event.reason === "quit") await manager.shutdown();
  });
}
