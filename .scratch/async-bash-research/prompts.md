# 四家异步 Shell 的提示词原文汇编

用途：改我们自己的提示词时逐句对照。这里只放模型可见的文本，不放实现说明。机制在 `codex.md`、`opencode.md`、`amp.md`、`unreal-agent.md` 里。

## 读法约定

- 代码块里的英文都是逐字原文，没有改写大小写与标点。
- 块外中文是说明，不是原文。
- 每段后面标了来源，格式是 `文件:行号`。Amp 没有源码，标 `bundle.js` 字符偏移。
- 原文里用 `${...}` 拼接的变量已展开，展开对照表在各自小节里。

## 版本与抽取方式

| 项目 | 锚点 | 抽取命令 |
|---|---|---|
| Codex | `04e365c69` | `curl -sS https://raw.githubusercontent.com/openai/codex/04e365c69/codex-rs/core/src/tools/handlers/shell_spec.rs` |
| OpenCode | `843a6c514e`（v2.0.32） | `curl -sS https://raw.githubusercontent.com/sst/opencode/843a6c514e/packages/core/src/tool/plugin/shell.ts` |
| Amp | `0.0.1794196844-g44d37b` | 本地 `~/20-dev/10-projects/temp/amp-cli-probe/bundle.js`，见该目录 `extract-js.py` |
| Unreal Agent | `a5f3fd1` | `curl -sS https://raw.githubusercontent.com/unreallabsai/unreal-agent/a5f3fd1/harness/tool/static.go` |

---

# 1. Codex

两个工具，`exec_command` 和 `write_stdin`。没有系统提示词里的工具条目，提示压力几乎全部压在工具描述和参数说明上。

## 1.1 工具描述

`exec_command`，`shell_spec.rs:90-96`

```text
Runs a command in a PTY, returning output or a session ID for ongoing interaction.
```

Windows 上会在这句后面追加一段 shell 使用指导，非 Windows 不出现。

`write_stdin`，`shell_spec.rs:140-141`

```text
Writes characters to an existing unified exec session and returns recent output.
```

## 1.2 参数说明

`exec_command`，`shell_spec.rs:33-73`

```text
cmd
Shell command to execute.

workdir
Working directory for the command. Defaults to the turn cwd.

tty
True allocates a PTY for the command; false or omitted uses plain pipes.

yield_time_ms
Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.

max_output_tokens
Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.

shell
Shell binary to launch. Defaults to the user's default shell.

login
True runs the shell with -l/-i semantics; false disables them. Defaults to true.

environment_id
Environment id from <environment_context>. Omit to use the primary environment.
```

Windows 上 `yield_time_ms` 换成另一段，`shell_spec.rs:27-29`

```text
Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms.
```

`write_stdin`，`shell_spec.rs:110-150`

```text
session_id
Identifier of the running unified exec session.

chars
Bytes to write to stdin. Defaults to empty, which polls without writing.

yield_time_ms
Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.

max_output_tokens
Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.
```

## 1.3 关闭统一执行后的另一份规格

`exec_command.rs:280-300` 运行时替换描述文本，并删掉 `tty` 与 `yield_time_ms`，加 `timeout_ms`。

```text
Runs a command to completion and returns its output. The process is terminated on timeout or cancellation and cannot be resumed.
```

```text
timeout_ms
Maximum command runtime. Defaults to 10000 ms.
```

## 1.4 输出字段说明

`shell_spec.rs:197-217`

```text
chunk_id
Chunk identifier included when the response reports one.

wall_time_seconds
Elapsed wall time spent waiting for output in seconds.

exit_code
Process exit code when the command finished during this call.

session_id
Session identifier to pass to write_stdin when the process is still running.

original_token_count
Approximate token count before output truncation.

output
Command output text, possibly truncated.
```

## 1.5 中断提示

`turn_aborted.rs:12-13`，这是 Codex 唯一提到后台进程还在跑的地方。

```text
The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.
```

## 1.6 值得注意的缺口

**没有任何一句教模型不要轮询。** 提示词里只有参数级的等待语义，轮询节奏完全交给模型。这是四家里唯一一家。

---

# 2. OpenCode

一个工具 `shell`，靠 `background` 参数分岔。轮询禁令是本汇编里语气最强的一段，被写成一个独立常量，后台分支的返回值会把它再附一遍。

## 2.1 工具描述

`tool/plugin/shell.ts:36-46`，由数组拼成一句话。

```text
Execute a shell command and return its output. Commands run on macOS using <shell>. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.
```

`<shell>` 是运行时选中的 shell 名，非 macOS 时这句里的系统名会换成 Windows 或 Linux。

## 2.2 参数说明

`shell.ts:48-63`

```text
command
Shell command string to execute

workdir
Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.

timeout
Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.

background
Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.
```

## 2.3 后台轮询禁令

`shell.ts:25-26`，常量 `BACKGROUND_INSTRUCTION`。

```text
You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.
```

## 2.4 后台返回值

`shell.ts:95-100`

```text
Command moved to the background (shell ID: <shellID>).
Output is streaming to: <file>
```

## 2.5 完成通知的正文

`shell/result.ts:54`

```xml
<shell id="<id>" state="completed|cancelled|error" command="<command>">
<output>
</shell>
```

## 2.6 截断说明

`shell.ts:228-252`

```text
[showing lines <start>-<end> of <total>; full output saved to <file>]
```

## 2.7 用户手动转后台时的说明

`packages/core/src/session.ts:444-461`，来源和自动完成通知不同。

```text
User requested that active blocking work be moved to the background.

Backgrounded work:
- <command>

The backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation.
```

---

# 3. Amp

四个工具，`shell_command`、`async_shell_command`、`shell_command_status`、`shell_command_kill`。提示词里嵌了变量，下面是展开后的结果。

## 3.1 变量展开对照

| 占位 | 实际值 |
|---|---|
| `${dg}` | `shell_command_status` |
| `${V1}` | `shell_command_kill` |
| `${Fdt}` | 见 3.2 第 3 条 |
| `${Udt}` | 见 3.2 第 4 条 |
| `${LFt}` | 见 3.3 第 3 条 |
| `${UFt}` | 见 3.3 第 4 条 |
| `${$Ft}` | 见 3.3 第 6 条 |

## 3.2 `shell_command`

`bundle.js:7791126`

```text
Runs a shell command and returns its output.
- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary. For manual file edits, use your file editing tool instead of Python or JavaScript scripts
- `workdir` must already exist before the command starts and must remain present for the whole command. Create it in a prior shell_command from an existing parent directory; do not delete it during the command.
- Do not invoke the Amp CLI or automate the web UI to delegate work, launch another agent, or message or continue an Amp thread. This includes `amp -x`, `amp --execute`, and `amp threads continue`. Use an available subagent or thread tool instead; if none is available, do the work directly. Only use those interfaces for this purpose when the user explicitly requests it. This restriction applies to commands you execute yourself, not commands you show the user to run as part of a documented human approval workflow.
- When downloading an Amp attachment URL, use `amp files get <attachment-url>` instead of curl or another command.
- Set `timeout_ms` to kill the command after the given wall-clock duration; omit it to let the command run without a timeout
```

参数，`bundle.js:7791739`

```text
command
Shell command to execute.

workdir
Optional working directory to run the command in; defaults to the turn cwd.

timeout_ms
The timeout for the command in milliseconds
```

## 3.3 `async_shell_command`

`bundle.js:7792224`

```text
Runs a shell command.
- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary. For manual file edits, use your file editing tool instead of Python or JavaScript scripts
- `workdir` must already exist before the command starts and must remain present for the whole command. Create it in a prior shell_command from an existing parent directory; do not delete it during the command.
- Do not invoke the Amp CLI or automate the web UI to delegate work, launch another agent, or message or continue an Amp thread. This includes `amp -x`, `amp --execute`, and `amp threads continue`. Use an available subagent or thread tool instead; if none is available, do the work directly. Only use those interfaces for this purpose when the user explicitly requests it. This restriction applies to commands you execute yourself, not commands you show the user to run as part of a documented human approval workflow.
- When downloading an Amp attachment URL, use `amp files get <attachment-url>` instead of curl or another command.
- This tool can run long-lived/background processes such as dev servers, watchers, test runs, log tails, and scripts that may take a while.
- `timeout_ms` controls how long this tool waits for the command before returning. It never stops the command. The default is 10000 milliseconds (10 seconds); valid values are 0 through 60000 milliseconds.
- Keep the default timeout for quick commands. When waiting on a slower command's result, set `timeout_ms` to its expected duration, up to 60000. This tool returns as soon as the process exits; use short waits only when you will do other work before checking again.
- If the command is still running after `timeout_ms`, this tool returns with `running: true` and a `pid`. This is normal for slow commands, not an error. The process continues in the background while you inspect files, edit code, or run other tools.
- `mode` sets what happens when the command is still running after `timeout_ms`. With `"async"`, the wait continues in the background, and a message naming the PID arrives when the command exits (after up to 30 minutes, the message says it is still running). Use it for work whose result you need, such as a build or a test run. With `"wait"`, no message follows; use it for commands that keep running, such as dev servers and watchers, and for quick commands.
- To check a background process, call shell_command_status with the returned `pid`. Do not rerun the original command just to get more output.
- To wait for a command, call shell_command_status on its PID. To wait for something no running command reports, such as a remote build finishing or a file appearing, start a loop that checks it (`until <check>; do sleep 15; done`) and wait on that loop's PID. NEVER poll with `sleep` in separate calls, such as repeated `sleep 60; <check>` calls: each call costs a full model turn, and a person's message cannot interrupt it. Do not detach a command you will wait on with `&` or `nohup`, because its PID is then not tracked.
- Avoid `pkill -f`: its pattern can match this tool's own shell and terminate the tool.
- Stop a background command this tool returned a `pid` for with shell_command_kill, not `kill <pid>`, and only when it looks hung (no new output across repeated shell_command_status checks and it is not expected to be long-running).
- shell_command_kill cannot stop other processes, such as a server started detached. To stop one, use its stop command or pidfile if it has one; otherwise confirm the PID with `ps -o pid,args -p <pid>` and run `kill <pid>` through this tool.
```

参数，`bundle.js:7793974`

```text
command
Shell command to execute.

workdir
Optional working directory to run the command in; defaults to the turn cwd.

timeout_ms
Milliseconds to wait for command completion before returning, from 0 to 60000. Defaults to 10000.

mode
"async": a message arrives when a command still running after timeout_ms exits. "wait": no message follows.
```

## 3.4 `shell_command_status`

`bundle.js:7794705`

```text
Waits for a background process started by shell_command and returns its new output.
- Use this tool after shell_command returned `running: true` and a `pid`. Pass that PID. This follows the existing process; it does not start or restart the command.
- It returns output produced since the last shell_command/shell_command_status read for that process, plus whether it is still running.
- The call blocks until the process exits, a new output line matches `pattern`, or `timeout_ms` passes, and streams new output as progress. `timeout_ms` defaults to 10000 and can be up to 270000 (4.5 minutes); set it to how long the work should take. Set `pattern` when a line, not the exit, means the work is done, such as a dev server's ready line. A new message from the user or another thread ends the call early.
- If a `timeout_ms` of 30000 or more passes while the process still runs, the wait continues in the background, and a message naming the PID arrives when the process exits or a line matches (after up to 30 minutes, the message says it is still running). Continue with other work; when you have nothing else to do, end your turn. Calling this tool or shell_command_kill on the same PID ends that background wait.
- Returning with `running: true` again is normal for slow or long-lived commands. The result also reports `runningFor` and `silentFor`, the time since the command last wrote output. Once `silentFor` exceeds the time the command should need, stop it with shell_command_kill instead of checking again.
```

参数，`bundle.js:7796218`

```text
pid
PID returned by shell_command.

timeout_ms
Milliseconds to block, from 0 to 270000. Defaults to 10000.

pattern
JavaScript regular expression tested against each new output line; the first match ends the wait. Example: "ready in|error".

mode
Set by Amp for background waits. Leave unset.
```

## 3.5 `shell_command_kill`

`bundle.js:7796832`

```text
Stops a hung background process started by shell_command.
- Only use this when the process appears hung: repeated shell_command_status checks returned `running: true` with no new output, and the command is not one you expect to run long (test suites, builds, installs, dev servers, watchers, and log tails should be left running).
- Never use this as a routine step just because shell_command or shell_command_status returned after `timeout_ms`. That only means the wait ended, not that the process is stuck.
- Use this instead of running `kill <pid>` through shell_command. It signals the process directly without starting a new shell, so it works even when the machine is overloaded and new commands are slow to start.
- Pass the PID returned by shell_command. The process and its children receive SIGTERM, then SIGKILL if still running about one second later. This tool waits up to two seconds for the process to exit and then returns its unread output and final status, like shell_command_status.
- If `running` is still true afterwards, check again with shell_command_status; do not rerun the command.
```

## 3.6 二进制输出占位

`bundle.js:3947311`

```text
[Command output omitted: output appears to contain binary data. Use a file-aware tool or redirect/encode binary output explicitly.]
```

## 3.7 注意

Amp 的服务端 system prompt 不可见，`bundle.js` 里只有 `systemPrompt:"puck"` 这类名字。上面全部是工具定义里的文本，不代表它的完整提示词。

---

# 4. Unreal Agent

一个工具 `Bash`，异步写在协议层。提示词极短，靠一条占位文本撑起整个交互约定。

## 4.1 工具描述

`harness/tool/static.go:54-70`

```text
Execute a shell command in background. Independent commands may be issued as parallel tool calls in one turn. Command child processes are killed when the shell exits.
```

## 4.2 参数说明

```text
command
The shell command to execute.

max_output_length
Maximum characters per output text field. Truncated text keeps its head and tail, around a marker stating how much was omitted, and path to the file with the complete stream. Defaults to 40000.
```

## 4.3 未完成时的占位结果

`harness/contextbuilder/builder.go:16`

```text
Tool call is still running. Its result arrives in a later turn: continue with independent work, or end your turn to wait for it.
```

这句话会替换任何运行中的结果，所以运行中的内容不会提前泄露。

## 4.4 心跳

`harness/coordinator/loop.go:302`

```text
Heartbeat: waited <n> seconds for tool calls.
Running: <list>
```

## 4.5 截断标记

`harness/operation/output.go:32`

```text
...<n> bytes truncated; complete output in <path>...
```

## 4.6 注意

没有超时参数，没有 kill 工具，没有系统提示词里的工具条目。模型侧只有一条路，结束本轮等结果。

---

# 5. 横向对照：谁在哪一段教模型不要轮询

这一栏是改我们提示词时最该看的部分。

| 项目 | 位置 | 强度 | 是否解释理由 |
|---|---|---|---|
| Codex | 无 | 完全没有 | 不适用 |
| OpenCode | 工具描述里的常量，后台分支返回值再附一遍 | 最强，两处重复 | 解释了，说反复 sleep 和读文件属于轮询，不是有用工作 |
| Amp | `async_shell_command` 的一条 bullet | 强，用大写 NEVER | 解释了，说每次调用花掉一整轮模型回合，而且人无法打断 |
| Unreal Agent | 占位文本 | 弱，只说"可以结束本轮去等" | 没有禁止轮询，因为它的机制不需要轮询 |

四家共同的问题处理方式，可以借的：

- OpenCode 的"如果没事做就结束回复，结束时你会被自动接续"，把结束本轮说成正常动作，而不是放弃。
- Amp 的"重复调用 `sleep` 检查会给每次检查付一整轮模型回合的代价"，给的是成本理由，模型更容易接受。
- Amp 的"返回 `running: true` 是正常结果，不是错误"，专门消掉模型看到运行中就想重跑一次的冲动。
- Amp 的 `silentFor`，用"多久没有新输出"代替"跑了多久"，让模型能判断卡死而不是只看时间。

---

# 附录：Pi 这一侧的现状

改之前先用这份做基线对照。原文来自 Pi 1.6.0 和本仓库 `index.ts`。

## A.1 系统提示词的工具清单

```text
- bash: Execute bash commands, handing off long-running commands after 30 seconds
- bash_task: Inspect or briefly wait for a handed-off bash task
```

## A.2 系统提示词的规则

```text
- You can inspect PI_* environment variables for current model and session details.
- When bash hands off a command, continue work that can proceed without its result. If nothing else can proceed, finish your turn; the completion message will resume the original conversation. Rerunning the command can repeat its side effects.
- Use bash_task with wait_seconds: 0 when the current log can inform useful work now. Wait briefly when your current tool call needs the exit result. Repeated waits or log checks just to learn whether bash finished keep the agent busy while Pi already tracks completion.
```

## A.3 `bash` 的说明

```text
Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. The timeout limits the command's total runtime, including time after handoff. If the command is still running after 30 seconds, bash returns status: running, task_id, and log_path while the same process continues. Pi delivers the final result to the original conversation automatically.
```

## A.4 `bash_task` 的说明

```text
Inspect or wait for a task handed off by bash. Returns its status, exit result if finished, log path, and a preview capped at 40 lines and 4 KiB with original line numbers. A finished task returns immediately. Expiring or cancelling the wait leaves the command running. When bash_task delivers the final result directly to the model, Pi skips the completion message.
```

## A.5 和四家的差距

Pi 是这五家里唯一有系统提示词层的。四家都只靠工具定义里的文本，没有独立的 snippet 条目，也没有统一的规则段。我们有这两层，交接规则可以写在规则里，不必全部塞进 description。

缺的东西：

- 缺 Amp 的"`running` 是正常结果，不是错误"。
- 缺 Amp 的 `silentFor`，也就是"距上次输出过了多久"，我们判断卡住只能靠模型自己估时间。
- 缺 Amp 的 `pattern`，它能让等待在某个正则命中新行时就结束，适合作好等待。我们只能按时间等。
- 缺 OpenCode 那种全大写的硬禁令。我们那条“不要反复查”是陈述句，语气弱一档。
- 30 秒是写死在描述里的常量，模型无法为某个命令要求更长的首轮等待。
