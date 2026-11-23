import { Type } from "typebox";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir, type BashToolDetails, type ExtensionAPI, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { getManager, maxWaitSeconds, type Handoff, type TaskResult } from "./src/tasks.ts";
import { installTaskStatus } from "./src/status.ts";

const reference = { task_id: Type.String(), log_path: Type.String() };
const handoffSchema = Type.Object({ ...reference, status: Type.Literal("running") });
const taskSchema = Type.Object({
  ...reference,
  status: Type.Union(["running", "exited", "timed_out", "stopped", "failed"].map(value => Type.Literal(value))),
  exit_code: Type.Optional(Type.Integer()),
  error: Type.Optional(Type.String()),
  log_error: Type.Optional(Type.String()),
  output_tail: Type.String(),
  truncated: Type.Boolean(),
  start_line: Type.Optional(Type.Integer()),
  end_line: Type.Optional(Type.Integer()),
  partial_line: Type.Optional(Type.Boolean()),
});

function formatTask(task: TaskResult) {
  const status = task.status === "exited" ? `exited with code ${task.exit_code}` :
    task.status === "timed_out" ? "timed out" : task.status;
  const log = `${task.log_error ? "Incomplete log" : "Log"}: ${task.log_path}`;
  const lines = task.start_line === undefined ? undefined :
    task.partial_line ? `Showing the end of line ${task.end_line}` :
      `Showing lines ${task.start_line}–${task.end_line}`;
  const heading = lines && (lines + (task.truncated ? " (preview truncated)" : ""));
  return [`Bash task ${task.task_id}: ${status}.`, log, task.error, task.log_error, heading, task.output_tail]
    .filter(Boolean).join("\n");
}

function completion(task: TaskResult) {
  return {
    customType: "async-bash-completion",
    content: formatTask(task),
    display: true,
    details: task,
  };
}

function handoffResult(data: Handoff) {
  return {
    content: [{ type: "text" as const, text: `Bash task ${data.task_id} is still running.\nLog: ${data.log_path}` }],
    details: data,
    structuredContent: { ...data },
  };
}

function taskResult(details: unknown): details is TaskResult {
  return !!details && typeof details === "object" && "task_id" in details && "output_tail" in details;
}

export default function asyncBash(pi: ExtensionAPI) {
  const manager = getManager(getAgentDir());
  const native = createBashToolDefinition(process.cwd());
  pi.registerTool<typeof native.parameters, BashToolDetails | Handoff | undefined>({
    ...native,
    description: native.description + " The timeout limits the command's total runtime, including time after handoff. If the command is still running after 30 seconds, bash returns status: running, task_id, and log_path while the same process continues. Pi delivers the final result to the original conversation automatically.",
    promptSnippet: "Execute bash commands, handing off long-running commands after 30 seconds",
    promptGuidelines: [
      ...(native.promptGuidelines ?? []),
      "When bash hands off a command, continue work that can proceed without its result. If nothing else can proceed, finish your turn; the completion message will resume the original conversation. Rerunning the command can repeat its side effects.",
    ],
    outputSchema: Type.Union([native.outputSchema!, handoffSchema]),
    renderResult(result, options, theme, ctx) {
      const details = result.details && "task_id" in result.details ? undefined : result.details;
      return native.renderResult!({ ...result, details }, options, theme, ctx);
    },
    async execute(id, input, signal, update, ctx) {
      const settings = pi.getSettings();
      const local = createLocalBashOperations({ shellPath: settings.shellPath });
      let foreground = true;
      try {
        const result = await manager.execute(ctx.sessionManager.getSessionId(), signal, execution =>
          createBashToolDefinition(ctx.cwd, {
            shellPath: settings.shellPath,
            commandPrefix: settings.shellCommandPrefix,
            operations: {
              async exec(command, cwd, options) {
                execution.start(options.timeout);
                try {
                  const result = await local.exec(command, cwd, {
                    ...options,
                    onData(data) { if (execution.log(data)) options.onData(data); },
                  });
                  execution.exited(result.exitCode);
                  return result;
                } catch (error) {
                  if (error instanceof Error && error.message.startsWith("timeout:")) execution.timedOut();
                  throw error;
                }
              },
            },
          }).execute(id, input, execution.signal, value => { if (foreground) update?.(value); }, ctx),
        );
        return "task_id" in result ? handoffResult(result) : result;
      } finally {
        foreground = false;
      }
    },
  });
  pi.registerTool({
    name: "bash_task",
    label: "bash task",
    description: "Inspect or wait for a task handed off by bash. Returns its status, exit result if finished, log path, and a preview capped at 40 lines and 4 KiB with original line numbers. A finished task returns immediately. Expiring or cancelling the wait leaves the command running. When bash_task delivers the final result directly to the model, Pi skips the completion message.",
    promptSnippet: "Inspect or briefly wait for a handed-off bash task",
    promptGuidelines: [
      "Use bash_task with wait_seconds: 0 when the current log can inform useful work now. Wait briefly when your current tool call needs the exit result. Repeated waits or log checks just to learn whether bash finished keep the agent busy while Pi already tracks completion.",
    ],
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID returned by bash." }),
      wait_seconds: Type.Optional(Type.Number({
        minimum: 0, maximum: maxWaitSeconds,
        description: `Maximum time to wait in seconds, from 0 to ${maxWaitSeconds} (default 30). Use 0 for an immediate snapshot.`,
      })),
    }, { additionalProperties: false }),
    outputSchema: taskSchema,
    async execute(_id, input, signal, _update, ctx) {
      const data = await manager.wait(ctx.sessionManager.getSessionId(), input.task_id, input.wait_seconds ?? 30, signal);
      return {
        content: [{ type: "text", text: formatTask(data) }],
        details: data,
        structuredContent: { ...data },
        isError: data.status !== "running" && (data.status !== "exited" || data.exit_code !== 0),
      };
    },
  });

  pi.registerCommand("bash-stop", {
    description: "Stop a background command: /bash-stop <task_id>",
    async handler(args, ctx) {
      const id = args.trim();
      if (!id) throw new Error("Usage: /bash-stop <task_id>");
      await manager.stop(ctx.sessionManager.getSessionId(), id);
      ctx.ui.notify(`Bash task ${id} has ended.`, "info");
    },
  });

  let unbind = () => {};
  pi.on("session_start", (_event, ctx) => {
    unbind();
    const owner = ctx.sessionManager.getSessionId();
    const disposeStatus = installTaskStatus(ctx, manager);
    let timer: ReturnType<typeof setImmediate> | undefined;
    const wake = () => {
      timer ??= setImmediate(() => {
        timer = undefined;
        if (!ctx.isIdle()) return;
        const [task] = manager.takeCompletions(owner, 1);
        if (task) pi.sendMessage(completion(task), { triggerTurn: true });
      });
    };
    const appendCompletions = (event: { outcome: string; entries: readonly SessionBoundaryDraft[] }) => {
      if (event.outcome !== "completed") return;
      const tasks = manager.takeCompletions(owner);
      if (tasks.length) return {
        entries: [...event.entries, ...tasks.map(task => ({ type: "custom_message" as const, ...completion(task) }))],
        continue: true,
      };
    };
    const off = [
      manager.subscribe(wake),
      pi.on("turn_end", event => {
        // Nested tools return to their caller. Only top-level tool results are visible to the model.
        for (const result of event.toolResults) {
          if (result.toolName === "bash_task" && taskResult(result.details) && result.details.status !== "running") {
            manager.markDelivered(owner, result.details.task_id);
          }
        }
        return appendCompletions(event);
      }),
      pi.on("agent_before_settle", appendCompletions),
      pi.on("agent_settled", wake),
      disposeStatus,
    ];
    wake();
    unbind = () => {
      clearImmediate(timer);
      for (const unsubscribe of off) unsubscribe();
    };
  });
  pi.on("session_shutdown", async event => {
    unbind();
    if (event.reason === "quit") await manager.shutdown();
  });
}
