import { Type } from "typebox";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir, type BashToolDetails, type ExtensionAPI, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { getManager, handoffMs, maxWaitSeconds, type Handoff, type TaskResult } from "./src/tasks.ts";
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
  const running = task.status === "running";
  const scope = task.log_error ? "Incomplete output" : running ? "Output so far" :
    task.truncated ? "Output truncated" : "Complete output";
  const lines = task.start_line === undefined ? "0 lines" :
    task.partial_line ? `showing the end of line ${task.end_line}` :
    task.truncated ? (task.start_line === task.end_line ? `showing line ${task.start_line}` :
      `showing lines ${task.start_line}–${task.end_line}`) :
    task.end_line === 1 ? "1 line" : `${task.end_line} lines`;
  const preview = task.truncated && (running || task.log_error) ? ", preview truncated" : "";
  const heading = `${scope} (${lines}${preview})`;
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
    content: [{ type: "text" as const, text: `Bash task ${data.task_id} is still running.\nLog: ${data.log_path}\nPi will deliver the final result to this conversation automatically. Continue independent work, or end your turn to wait.` }],
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
  const parameters = {
    ...native.parameters,
    properties: {
      ...native.parameters.properties,
      command: { ...native.parameters.properties.command, description: "Shell command to execute." },
      timeout: { ...native.parameters.properties.timeout, description: "Maximum command runtime in seconds, including after handoff. Reaching this limit terminates the command. Omit for no timeout." },
    },
  };
  pi.registerTool<typeof native.parameters, BashToolDetails | Handoff | undefined>({
    ...native,
    exposure: "model-only",
    parameters,
    description: `Run a Bash command in the current working directory and return its stdout and stderr. The text result keeps at most the last 2,000 lines or 50 KiB, whichever limit is reached first. If truncated, the full output is saved to a temporary file. In one-shot print and JSON modes, wait for the command to finish. In interactive and RPC sessions, if the command is still running after ${handoffMs / 1000} seconds, hand it off and return status: running, task_id, and log_path. The same command keeps running, and Pi delivers its final result to the original conversation automatically.`,
    promptSnippet: "Run Bash commands with background handoff for long-running commands",
    promptGuidelines: [
      ...(native.promptGuidelines ?? []),
      "When bash hands off a command, running means the original command is still executing. Pi tracks it and automatically delivers the final result to this conversation. Continue work that can proceed without it. If all remaining work depends on the result, end your turn; Pi will resume the conversation when the result is ready. Do not rerun the command just to get its result, since that can repeat its side effects.",
      "In codemode scripts, use tools.bash_sync to run shell commands.",
    ],
    outputSchema: Type.Union([native.outputSchema!, handoffSchema]),
    renderResult(result, options, theme, ctx) {
      const details = result.details && "task_id" in result.details ? undefined : result.details;
      return native.renderResult!({ ...result, details }, options, theme, ctx);
    },
    async execute(id, input, signal, update, ctx) {
      const settings = pi.getSettings();
      const shellOptions = { shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix };
      if (ctx.mode === "print" || ctx.mode === "json") {
        return createBashToolDefinition(ctx.cwd, shellOptions).execute(id, input, signal, update, ctx);
      }
      const local = createLocalBashOperations({ shellPath: settings.shellPath });
      let foreground = true;
      try {
        const result = await manager.execute(ctx.sessionManager.getSessionId(), signal, execution =>
          createBashToolDefinition(ctx.cwd, {
            ...shellOptions,
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
    ...native,
    name: "bash_sync",
    label: "bash sync",
    exposure: "codemode",
    description: "Run a Bash command in the current working directory and wait for its result, including on nonzero exit. Returns output, truncated, exit_code, wall_time_seconds, and full_output_path when the structured output is truncated. The command timeout and the script deadline apply when set. The script occupies a codemode worker while it waits. Use bash directly for long-running commands that can be handed off.",
    promptSnippet: undefined,
    promptGuidelines: undefined,
    async execute(id, input, signal, update, ctx) {
      const settings = pi.getSettings();
      return createBashToolDefinition(ctx.cwd, {
        shellPath: settings.shellPath,
        commandPrefix: settings.shellCommandPrefix,
      }).execute(id, input, signal, update, ctx);
    },
  });
  pi.registerTool({
    name: "bash_task",
    label: "bash task",
    exposure: "model-only",
    description: "Inspect or wait on the handed-off Bash task identified by task_id. Returns its status, exit code when available, log path, and a preview of up to 40 lines and 4 KiB with original line numbers. An already finished task returns immediately. Reaching the wait limit or cancelling the wait leaves the command running. If this call delivers the final result directly to the model, Pi skips the separate completion message.",
    promptSnippet: "Inspect a handed-off Bash task or wait on it",
    promptGuidelines: [
      "Do not poll handed-off Bash tasks for completion by sleeping, repeatedly reading logs, or repeatedly calling bash_task. Pi already tracks completion. A sleep call can keep you waiting even after the command has finished.",
      "Use bash_task with wait_seconds: 0 if output already produced can inform an action now, or if the user asks for progress. If the user explicitly asks to block on an existing task, make one bounded bash_task call with an explicit wait_seconds. If it returns running, leave completion to Pi.",
    ],
    parameters: Type.Object({
      task_id: Type.String({ description: "Task ID returned by bash at handoff." }),
      wait_seconds: Type.Optional(Type.Number({
        minimum: 0, maximum: maxWaitSeconds,
        description: `Maximum time this call waits for the task to finish, in seconds. Use 0 for an immediate snapshot. Accepts 0 to ${maxWaitSeconds}. Defaults to 30.`,
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
