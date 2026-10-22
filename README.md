# Async Bash

Codex-style command sessions for Pi: start a command, get its output, then keep waiting or send input to the same process.

> This working tree replaces the old 63-second background/notification design. The new interface is not published yet. Verified with Pi 1.4.0, Node 22.23.2 and macOS. Linux uses the same Unix implementation but has not been tested; Windows is not supported.

## Try locally

```bash
npm ci
pi -e ./index.ts
```

This loads the extension for one invocation without changing Pi settings. Do not load another extension that also overrides `bash`.

The package depends on `node-pty`. Its install hook restores executable permissions on the Unix spawn helper shipped by node-pty 1.1.0. If installation scripts were disabled, run `npm run postinstall` before trying PTY mode. Native builds may require platform build tools when no compatible prebuilt binary is available.

## Tools

### bash

```typescript
bash({
  command: "cd /path/to/project && npm test",
  yield_time_ms: 10000,       // optional; default 10000, clamped to 250–30000
  tty: false,                // optional; allocate a PTY when true
})
```

Short commands return output and an exit code. Commands still running at the end of the wait return output and a numeric `session_id`. The command is not restarted.

There is no execution timeout. `yield_time_ms` limits only this tool call's wait. The command keeps running until it exits, is explicitly stopped, or Pi exits.

Commands start in Pi's current directory. Use `cd … && …` to change directory for a command; it does not change the directory for subsequent tools. There is no `workdir` parameter. Shell selection and command prefixes use Pi's `shellPath` and `shellCommandPrefix` settings; initialization and prefixes run before any `cd` in the command. Session/model environment variables are supplied at launch.

### write_stdin

Continue waiting without sending input:

```typescript
write_stdin({ session_id: 12345, yield_time_ms: 300000 })
```

Or send input:

```typescript
write_stdin({ session_id: 12345, chars: "yes\n" })
```

| Input | Default wait | Effective range |
| --- | --- | --- |
| Empty or omitted `chars` | 5 seconds | 5–300 seconds |
| Non-empty `chars` | 250 milliseconds | 250–30000 milliseconds |

Completion returns early. A window expiring does not stop the process. Use another `write_stdin` call when you need its result; there is no need to construct shell sleep-and-tail loops.

Calls return only newly collected output. Interactions with the same process are ordered; different processes can run concurrently.

The wait window also covers pipe backpressure. Input remains queued in order if the window expires before the program reads it; returning a running session does not confirm that the program has consumed the input.

### Results

Both tools return the same structured data to codemode:

```typescript
{ output: "Starting tests...\n", truncated: false, wall_time_seconds: 0.25, session_id: 12345 }
// Later:
{ output: "Tests passed.\n", truncated: false, wall_time_seconds: 0.8, exit_code: 0 }
```

`session_id` means the command is still running. `exit_code` means it has ended. This ID is a command reference, not an OS PID or a Pi conversation ID.

A non-zero exit is marked as a tool error while retaining structured output and the exit code. Reading an already-finished session again returns any unread output and its original exit code.

`truncated` describes only the new output returned by this call. When true, `full_output_path` points to the complete raw log for the entire command, including earlier output. The path is omitted when this call is not truncated.

`wall_time_seconds` is this tool call's elapsed time, including queueing, input backpressure and waiting. It is not the command's total lifetime or the requested wait window.

## PTY and stopping

Use `tty: true` for terminal-dependent programs. PTYs use an 80×24 terminal and support normal terminal input, including Ctrl+C:

```typescript
write_stdin({ session_id: 12345, chars: "\u0003" })
```

In pipe mode, that character is ordinary input, not an interrupt signal. To explicitly stop either kind of session, use the user command:

```text
/bash-stop 12345
```

This stops the managed Unix process group and waits for its exit. It does not promise to stop descendants that deliberately leave that group.

When the main command exits, any remaining processes in its managed group are stopped as well. The main command's original exit code is preserved.

- Cancel the initial `bash` call before it returns a reference: the command is stopped.
- Cancel a later `write_stdin`: only that interaction is cancelled; the command continues and unread output is retained.
- Stop an already-finished session: its original result is preserved.

## Output and lifecycle

Output is bounded using Pi's default 2000-line / 50-KiB limits. Truncated output includes a full log path in its text. Raw stdout/stderr are saved under `<agent dir>/extension-data/async-bash/`, including short calls. Logs are not automatically deleted.

The native Footer shows running, handed-off commands for the current session, for example `BG 2 · 12s / 3s`. It does not replace Pi's Footer.

Sessions survive reload and switching conversations within the same Pi process. A fork that inherits a reference can use the same process; it does not copy it. Unrelated conversations cannot operate on a session just by guessing its ID. Output has one shared read position per process, including inherited references.

Normal Pi exit and handled termination clean up managed processes. A new Pi process cannot resume old command sessions; old references are rejected. SIGKILL/crash cleanup is not guaranteed.

**Completion does not send a message or wake the model.** If the model needs the result, it must continue with `write_stdin`. No task snapshots are injected into model requests.

## Changes from the old design

- Default initial wait is 10 seconds instead of 63.
- Added `yield_time_ms`, `tty` and `write_stdin`.
- Removed `timeout`, the experimental `workdir` parameter and `bash_task`; old arguments are rejected rather than silently ignored.
- Removed completion notifications, automatic turns, moving context snapshots and JSON task-state recovery.
- Previous log files are left untouched; old task IDs are not migrated.

The current compact-tool renderer can coexist in either load order, but this extension does not promise its old `Backgrounded` styling.

## Development

```bash
npm ci
npm run check
npm test
```

Tests use real AgentSessions, CLI/RPC, Unix child processes and PTYs with a local deterministic provider. No model API is called. The suite includes a real default ten-second handoff.

The plugin owns the interactive pipe/PTY backend because native Bash does not expose a writable stdin or resumable process handle. It reuses Pi's public Shell configuration and truncation helpers, and adapts the native PATH and output-draining behavior without private imports or changes to Pi.

Both tools provide system-prompt snippets and guidelines adapted from Codex, including its advice to avoid blocking sleep/wait calls longer than 60 seconds. This is model guidance, not a hard runtime limit; the maximum empty wait remains 300 seconds. Codemode also receives these guidelines through Pi's normal tool declarations.

RPC tests retain event streams, stderr, sessions and logs in temporary artifact directories printed in their output.

The current contract is in `SPEC.md`; implementation and review records are in `TICKETS.md`. Earlier investigation documents describe historical designs.

## License

MIT
