import { delimiter, join } from "node:path";
import { accessSync, constants } from "node:fs";
import { Type } from "typebox";
import { createBashToolDefinition, getAgentDir, getShellConfig, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getManager, type ProcessResult } from "./src/tasks.ts";
import { installTaskStatus, taskReferences } from "./src/status.ts";

export default function asyncBash(pi: ExtensionAPI) {
  const manager = getManager(join(getAgentDir(), "extension-data", "async-bash"));
  const nativeBash = createBashToolDefinition(process.cwd());
  const sessionId = Type.Integer({ minimum: 1, maximum: 0x7ffffffe });
  const outputSchema = Type.Object({
    output: Type.String(),
    truncated: Type.Boolean({ description: "Whether this call's new output was truncated." }),
    full_output_path: Type.Optional(Type.String({ description: "Full command log, present when this call's output is truncated." })),
    wall_time_seconds: Type.Number({ minimum: 0, description: "Elapsed time of this tool call, not the command's total lifetime." }),
    exit_code: Type.Optional(Type.Integer()),
    session_id: Type.Optional(sessionId),
  }, { additionalProperties: false });
  const result = (data: ProcessResult & { wall_time_seconds: number }) => ({
    content: [{ type: "text" as const, text: data.output +
      (data.session_id !== undefined ? "\nProcess running with session ID " + data.session_id :
        "\nProcess exited with code " + data.exit_code) }],
    details: data, structuredContent: { ...data },
    isError: data.exit_code !== undefined && data.exit_code !== 0,
  });
  const access = (ctx: ExtensionContext) => ({
    owner: ctx.sessionManager.getSessionId(), references: taskReferences(ctx.sessionManager.getBranch()),
  });
  const remember = (data: ProcessResult, ctx: ExtensionContext, started: number) => {
    if (data.session_id !== undefined && !taskReferences(ctx.sessionManager.getBranch()).has(data.session_id)) {
      pi.appendEntry("async-bash-process", { session_id: data.session_id });
    }
    return result({ ...data, wall_time_seconds: (performance.now() - started) / 1000 });
  };
  pi.registerTool({
    name: "bash", label: "bash",
    executionMode: "parallel",
    description: "Runs a shell command, returning output or a session ID for ongoing interaction. Use write_stdin to continue the session. Output is bounded to 2000 lines or 50 KiB. Cancelling this call before it returns stops the process.",
    promptSnippet: nativeBash.promptSnippet,
    promptGuidelines: [
      ...(nativeBash.promptGuidelines ?? []),
      "Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.",
      "Treat shell command text as code. JSON.stringify() is not shell escaping; use proper shell quoting.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute." }),
      yield_time_ms: Type.Optional(Type.Number({ minimum: 0, description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms. Commands that finish sooner return immediately. This does not limit command runtime; commands have no execution timeout." })),
      tty: Type.Optional(Type.Boolean({ description: "True allocates a PTY for the command; false or omitted uses plain pipes." })),
    }, { additionalProperties: false }),
    outputSchema,
    async execute(_id, input, signal, update, ctx) {
      const started = performance.now();
      const settings = pi.getSettings();
      const cwd = ctx.cwd;
      accessSync(cwd, constants.X_OK);
      const shell = getShellConfig(settings.shellPath);
      if (shell.commandTransport === "stdin") throw new Error("Shells that read commands from stdin are not supported.");
      const env = { ...process.env };
      // Match Pi 1.4.0 getShellEnv without importing its private implementation.
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
      const paths = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
      const bin = join(getAgentDir(), "bin");
      if (!paths.includes(bin)) paths.unshift(bin);
      env[pathKey] = paths.join(delimiter);
      for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
      env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
      const file = ctx.sessionManager.getSessionFile();
      if (file) env.PI_SESSION_FILE = file;
      if (ctx.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; }
      env.PI_REASONING_LEVEL = ctx.thinkingLevel;
      const data = await manager.execute({
        owner: ctx.sessionManager.getSessionId(), cwd, shell: shell.shell, args: shell.args,
        command: settings.shellCommandPrefix ? settings.shellCommandPrefix + "\n" + input.command : input.command,
        env, tty: input.tty ?? false, yield_time_ms: input.yield_time_ms, signal,
        update: output => update?.({ content: [{ type: "text", text: output }], details: undefined }),
      });
      return remember(data, ctx, started);
    },
  });
  pi.registerTool({
    name: "write_stdin", label: "write_stdin",
    executionMode: "parallel",
    description: "Writes characters to an existing command session and returns only new output. Cancelling this call only stops waiting, not the process.",
    promptSnippet: "Send input to a command session or wait for new output",
    promptGuidelines: [
      "When bash or write_stdin returns a session_id, use write_stdin with that ID to continue the same process. Do not restart the command just because a wait window expired.",
      "There is no completion notification or automatic wake-up. If the user's task requires the result, keep using write_stdin until completion.",
    ],
    parameters: Type.Object({
      session_id: Type.Integer({ minimum: 1, maximum: 0x7ffffffe, description: "Identifier of the command session returned by bash or write_stdin." }),
      chars: Type.Optional(Type.String({ description: "Characters to write to stdin. Defaults to empty, which polls without writing. In PTY mode, can contain Ctrl+C (\\u0003). In pipe mode, Ctrl+C is ordinary input, not a signal." })),
      yield_time_ms: Type.Optional(Type.Number({ minimum: 0, description: "Wait before yielding output. Non-empty writes default to 250 ms; effective range is 250-30000 ms. Empty polls default to 5000 ms; effective range is 5000-300000 ms. Commands that finish sooner return immediately. This does not limit command runtime." })),
    }, { additionalProperties: false }),
    outputSchema,
    async execute(_id, input, signal, update, ctx) {
      const started = performance.now();
      return remember(await manager.input(input.session_id, input.chars ?? "", input.yield_time_ms, access(ctx), signal,
        output => update?.({ content: [{ type: "text", text: output }], details: undefined })), ctx, started);
    },
  });
  pi.registerCommand("bash-stop", {
    description: "Stop a command and its process group: /bash-stop <session_id>",
    async handler(args, ctx) {
      if (!/^[1-9]\d*$/.test(args.trim())) throw new Error("Usage: /bash-stop <session_id>");
      const id = Number(args.trim());
      await manager.stop(id, access(ctx));
      ctx.ui.notify("Command session " + id + " stopped.", "info");
    },
  });
  let unbind = () => {};
  pi.on("session_start", (_event, ctx) => {
    unbind();
    unbind = installTaskStatus(pi, ctx, manager);
  });
  pi.on("session_shutdown", async event => {
    unbind();
    if (event.reason === "quit") await manager.shutdown();
  });
}
