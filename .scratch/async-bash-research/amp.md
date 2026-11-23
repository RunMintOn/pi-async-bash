# Amp：pid 为中心的四个 shell 工具

版本 `0.0.1794196844-g44d37b`（2026-11-09）。无源码，证据来自 `bundle.js` 字符偏移。偏移是可 grep 的原文锚点，升级后重抽一次再核对。

## 1. 形态

pid 是全局句柄。启动工具负责给 pid，后续工具都按 pid 追。四个工具各有明确分工。

| 工具 | 角色 | 被谁等待 |
|---|---|---|
| `shell_command` | 阻塞执行，超时杀掉 | 无 |
| `async_shell_command` | 超时后进程继续，返回 pid | `mode` 决定 |
| `shell_command_status` | 按 pid 跟随新输出 | 模型自己调 |
| `shell_command_kill` | 按 pid 终止 | 无 |

## 2. 怎么启动

`shell_command` 描述。`bundle.js:7791094`

```text
Runs a shell command and returns its output.
- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary. For manual file edits, use your file editing tool instead of Python or JavaScript scripts
- `workdir` must already exist before the command starts and must remain present for the whole command. Create it in a prior shell_command from an existing parent directory; do not delete it during the command.
- Set `timeout_ms` to kill the command after the given wall-clock duration; omit it to let the command run without a timeout
```

`async_shell_command` 描述。`bundle.js:7792198`

```text
Runs a shell command.
- ...
- This tool can run long-lived/background processes such as dev servers, watchers, test runs, log tails, and scripts that may take a while.
- `timeout_ms` controls how long this tool waits for the command before returning. It never stops the command. The default is 10000 milliseconds (10 seconds); valid values are 0 through 60000 milliseconds.
- Keep the default timeout for quick commands. When waiting on a slower command's result, set `timeout_ms` to its expected duration, up to 60000. This tool returns as soon as the process exits; use short waits only when you will do other work before checking again.
- `mode` sets what happens when the command is still running after `timeout_ms`. With `"async"`, the wait continues in the background, and a message naming the PID arrives when the command exits (after up to 30 minutes, the message says it is still running). Use it for work whose result you need, such as a build or a test run. With `"wait"`, no message follows; use it for commands that keep running, such as dev servers and watchers, and for quick commands.
- If the command is still running after `timeout_ms`, this tool returns with `running: true` and a `pid`. This is normal for slow commands, not an error. The process continues in the background while you inspect files, edit code, or run other tools.
- To check a background process, call shell_command_status with the returned `pid`. Do not rerun the original command just to get more output.
- To wait for a command, call shell_command_status on its PID. To wait for something no running command reports, such as a remote build finishing or a file appearing, start a loop that checks it (`until <check>; do sleep 15; done`) and wait on that loop's PID. NEVER poll with `sleep` in separate calls, such as repeated `sleep 60; <check>` calls: each call costs a full model turn, and a person's message cannot interrupt it. Do not detach a command you will wait on with `&` or `nohup`, because its PID is then not tracked.
- Avoid `pkill -f`: its pattern can match this tool's own shell and terminate the tool.
- Stop a background command this tool returned a `pid` for with shell_command_kill, not `kill <pid>`, and only when it looks hung ...
- shell_command_kill cannot stop other processes, such as a server started detached. ...
```

参数只有 `command`、`workdir`、`timeout_ms`、`mode`（必填，`wait`/`async`）。`bundle.js:7794400-7794480`

## 3. 启动返回什么

超时未退出时返回运行态，带 pid 与已产生的输出。`bundle.js:3949301` 起的 `Fzr`：

```js
c.next({status:"done",result:{...n5(g.output),running:!0,pid:g.pid}})
```

- `running: true` 与 `pid` 同时出现，是正常返回，不是错误。
- 退出时返回 `output` 与 `exitCode`（拿不到时为 `-1`）。
- 输出按尾部截断，上限 50000 字符。`bundle.js:7658405` 的 `cEe={maxCharacterLength:XA}`，`XA=50000` 在 `bundle.js:3947302`。
- 二进制输出不返回原文，给固定占位文案。`bundle.js:3947311`

```text
[Command output omitted: output appears to contain binary data. Use a file-aware tool or redirect/encode binary output explicitly.]
```

## 4. 怎么再读输出

`shell_command_status(pid, timeout_ms?, pattern?)`。`bundle.js:7794673`

```text
Waits for a background process started by shell_command and returns its new output.
- Use this tool after shell_command returned `running: true` and a `pid`. Pass that PID. This follows the existing process; it does not start or restart the command.
- It returns output produced since the last shell_command/shell_command_status read for that process, plus whether it is still running.
- The call blocks until the process exits, a new output line matches `pattern`, or `timeout_ms` passes, and streams new output as progress. `timeout_ms` defaults to 10000 and can be up to 270000 (4.5 minutes); set it to how long the work should take. Set `pattern` when a line, not the exit, means the work is done, such as a dev server's ready line. A new message from the user or another thread ends the call early.
- If a `timeout_ms` of 30000 or more passes while the process still runs, the wait continues in the background, and a message naming the PID arrives when the process exits or a line matches (after up to 30 minutes, the message says it is still running). Continue with other work; when you have nothing else to do, end your turn. Calling this tool or shell_command_kill on the same PID ends that background wait.
- Returning with `running: true` again is normal for slow or long-lived commands. The result also reports `runningFor` and `silentFor`, the time since the command last wrote output. Once `silentFor` exceeds the time the command should need, stop it with shell_command_kill instead of checking again.
```

实现要点，`bundle.js:2196064` 的 `Yit`：

- 读取游标 `readOffset`，每次调用只给上次之后的新输出。
- `pattern` 只匹配新行，命中就结束等待。
- 等待期间每 200 ms 推一次 progress。`bundle.js:3949185` 附近的 `xzr=200`。
- `timeout_ms` 夹在 0 到 270000；`mode:"async"` 时默认与上限都变成 30 分钟。`bundle.js:6205456` 的 `MFt={defaultMs:1e4,maxMs:270000}`、`OFt={defaultMs:yfe,maxMs:yfe}`，`yfe=1800000` 在 `bundle.js:3845184`。
- `mode` 是隐藏参数，描述写着 `"Set by Amp for background waits. Leave unset."`，由宿主注入。

## 5. 完成怎样被感知

`mode:"async"` 时，进程结束后会来一条消息。消息头的常量。`bundle.js:3845200`

```text
B3e="A background wait you started has ended. This message comes from Amp, not from the user."
```

消息体格式从解析侧可还原为 `Status:` / `Command:` / `Result:` 或 `Error:`，并且可能带一行 `A new output line matched the pattern: ...`。`bundle.js:1871965` 的 `nJe` 按这些前缀反解。

投递方式：这条消息是 user 角色的消息，带 `fromSubagentToolUseID`，指向发起等待的那次工具调用。`bundle.js:1782671` 的 `UOr` 就是按这个字段把消息挂回工具行。

**推断**：`B3e` 在 bundle 里只有 3 处引用，全部是解析或展示侧，没有生产者。消息文案与投递应由服务端生成，本地只能观察到落下来的形态。

## 6. 模型怎样被唤醒

同一条 user 消息就是唤醒源。Amp 的会话由服务端驱动，客户端只负责渲染与执行工具调用。

可读到的模型侧规则在工具描述里，核心是这条。`bundle.js:6205519`

```text
- To wait for a command, call shell_command_status on its PID. To wait for something no running command reports, such as a remote build finishing or a file appearing, start a loop that checks it (`until <check>; do sleep 15; done`) and wait on that loop's PID. NEVER poll with `sleep` in separate calls, such as repeated `sleep 60; <check>` calls: each call costs a full model turn, and a person's message cannot interrupt it. Do not detach a command you will wait on with `&` or `nohup`, because its PID is then not tracked.
```

这段把「别 sleep 轮询」的理由说成成本问题：每次调用消耗一整轮模型 turn，而且用户消息无法打断。

## 7. 并发与隔离

- 全局进程表按 pid 索引，`bundle.js:7658405` 附近的 `sd=new Map`。
- 只有本进程启动过的 pid 才能被 status/kill 跟随，否则返回「不是本进程启动的」。`bundle.js:3952245`
- 已退出进程保留 1 小时，超时清理。`bundle.js:3949185` 的 `kzr=3600000`。
- 每个 thread 还有一张 `qT` 映射，记录「哪次工具调用起了哪个进程」，用于 UI 计数与消息归属。`bundle.js:3949301` 里的 `isRootExecutorLease` 分支。
- 输出按字符数截尾，超过就丢前段并同步修正读取游标。`bundle.js:2181430` 的 `n5` 与 `Cae`/`kae`。

## 8. 超时与取消

- 阻塞型 `shell_command`：`timeout_ms` 到点杀进程。`bundle.js:7791094`。
- `async_shell_command`：`timeout_ms` 只限制等待，从不杀进程。进程留在表里等下一次 status 或 kill。
- `shell_command_kill`：SIGTERM 到进程组，1 秒后仍在就 SIGKILL，再等最多 2 秒拿最终状态与未读输出。`bundle.js:7796800`、`bundle.js:3949163` 的 `Wit=1000`、`Tzr=Wit*2`。

```text
- Pass the PID returned by shell_command. The process and its children receive SIGTERM, then SIGKILL if still running about one second later. This tool waits up to two seconds for the process to exit and then returns its unread output and final status, like shell_command_status.
```

- 信号先打进程组，失败再打单进程。`bundle.js:2195030` 附近的 `$zr`。

## 9. 输出预算

- 单进程输出保留 50000 字符，超出按行边界丢前段。`XA=50000`、`n5` 的尾截断。
- status 每次只返回上次之后的新输出，模型看不到同一段两次。
- 二进制判定命中后整段丢弃，只给占位说明，并把游标归零。

## 10. 边界与已知坑

- 命令退出但子进程还占着管道时，输出不会关闭。实现会在 1 秒后补一行说明并保留句柄。`bundle.js:2195030` 的 `Lzr`：

```text
The command exited, but a process it started is still running and holds its output open. Stop it with shell_command_kill on PID <pid> if it is not needed.
```

- 命令被信号杀死时补一行「terminated by signal N (no exit code)」。同处的 `Nzr`。
- `pkill -f` 可能匹配到工具自己的 shell，描述里明确劝阻。
- 自己 `&` 或 `nohup` 出去的后代拿不到 pid，后续无法跟随，也无法用 kill 工具停止。
- 超出 1 小时保留窗口的 pid 会被清掉，之后 status 只能报「未知 pid」。`bundle.js:3951902` 的 `Qzr`。
- 同一个 pid 再调 status 或 kill 会结束已有的后台等待。

## 11. 已知空白

- `bundle.js` 里有两份互不相同的 `shell_command_status` 描述：一份 0–60000 ms、无 `pattern`（`bundle.js:3801579`），一份 0–270000 ms、带 `pattern` 与后台延续（`bundle.js:7794673`）。前者出现在被复制的旧模块里，实际注册的是后者。两份为何共存没有证据。
- 服务端的 system prompt 不可见，`bundle.js` 里只有 `systemPrompt:"puck"` 这类名字。工具怎么被选中、`mode:"async"` 由谁注入，只能看到参数说明。
- 后台等待消息的生产者不在 bundle 内，30 分钟上限到点后的文案原文无法逐字确认。
- 未实机运行，`runningFor` / `silentFor` 的实际精度、进度流式推送的观感都未验证。
