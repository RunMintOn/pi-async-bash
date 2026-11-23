# Codex：Unified Exec

commit `04e365c69`。核心代码 `codex-rs/core/src/unified_exec/`，工具定义 `codex-rs/core/src/tools/handlers/shell_spec.rs`。

## 1. 形态

一个进程表，两个工具。没有「后台开关」，也没有完成通知。长命令就是留在表里的一个进程，模型想看时再调一次 `write_stdin`。

```
exec_command(cmd, yield_time_ms)  ──超时未退出──▶  session_id
                                                    │
                                    write_stdin(session_id)  ──▶ 新输出 / exit_code
```

## 2. 怎么启动

`exec_command` 参数：`cmd`（必填）、`workdir`、`tty`、`yield_time_ms`、`max_output_tokens`、`shell`、`login`，多环境时加 `environment_id`，另有沙箱审批参数。

`sandbox_permissions` 三态（`use_default` / `with_additional_permissions` / `require_escalated`），前缀规则 `prefix_rule` 可复用审批。`codex-rs/core/src/tools/handlers/shell_spec.rs:14-108`

工具描述全文：

```text
Runs a command in a PTY, returning output or a session ID for ongoing interaction.
```

```text
Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.
```

`tty` 决定 PTY 还是管道。`shell_spec.rs:20-40`

关闭 `Feature::UnifiedExec` 时，注册的是另一份只跑到底的 spec：删掉 `tty` 与 `yield_time_ms`，加 `timeout_ms`，描述改成限制更窄的版本。`codex-rs/core/src/tools/spec_plan.rs:1269-1277`、`codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:280-300`

```text
Runs a command to completion and returns its output. The process is terminated on timeout or cancellation and cannot be resumed.
```

```text
Maximum command runtime. Defaults to 10000 ms.
```

## 3. 启动返回什么

输出 schema 固定六个字段。`shell_spec.rs:160-185`

```json
{"chunk_id":"...","wall_time_seconds":0,"exit_code":0,"session_id":0,
 "original_token_count":0,"output":"..."}
```

- 等待窗口内退出：给 `exit_code`，`session_id` 缺省。
- 窗口到期仍在跑：给 `session_id`，`exit_code` 缺省。进程留在表里。
- 窗口被夹在 250–30000 ms。`unified_exec/mod.rs:66-70`、`process_manager.rs:212`

启动即失败、沙箱拒绝、网络审批拒绝都会走错误分支，不承诺「已启动」。`process_manager.rs:545-700`

## 4. 怎么再读输出

`write_stdin(session_id, chars?, yield_time_ms?, max_output_tokens?)` `shell_spec.rs:110-146`

```text
Writes characters to an existing unified exec session and returns recent output.
```

```text
Bytes to write to stdin. Defaults to empty, which polls without writing.
```

```text
Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.
```

- 每次调用都把缓冲区 `take` 走，只返回上次读取之后的新输出。`process_manager.rs:1607-1622`
- 同一进程的写入与轮询由 `interaction_lock` 串行化，不同进程可并发。`process_manager.rs:913-920`
- 空轮询夹在 5 s 到 `max_write_stdin_yield_time_ms`（默认 300 s）。`process_manager.rs:1034-1048`、`mod.rs:68-71`
- 非 TTY 会话不接受普通输入，只接受 `\u{3}`（Ctrl-C）；其他内容返回 `StdinClosed`。`process_manager.rs:1011-1027`、`process_manager.rs:109`
- 写完后固定 sleep 100 ms 再收输出，提高一次调用内拿到反应的几率。`process_manager.rs:1023-1028`

## 5. 完成怎样被感知

进程退出后，`spawn_exit_watcher` 等输出排空，发出一个 `ExecCommandEnd` 事件，聚合整段输出。`unified_exec/async_watcher.rs:169-200`

这个事件进会话记录与前端，**不进下一轮模型输入**。同时 `start_streaming_output` 按 8 KiB 上限发 `ExecCommandOutputDelta`，单次调用最多 10000 个 delta。`async_watcher.rs:44-47`、`codex-rs/core/src/exec.rs:85`

模型侧唯一的完成信号是：某次 `write_stdin` 没有返回 `session_id`，而是返回 `exit_code`。

## 6. 模型怎样被唤醒

不唤醒。没有「命令结束 → 自动起一轮」。中断提示只说后台可能还有进程在跑。`codex-rs/core/src/context/turn_aborted.rs:12-13`

```text
The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.
```

轮询节奏完全交给模型。仓库里没有一条提示词教模型「别轮询」，只有 schema 里的等待语义。另有一个 `clock.sleep` 工具，任意时长，期间来了新输入会提前结束。`codex-rs/core/src/tools/handlers/sleep.rs:47-60`

## 7. 并发与隔离

- 进程表上限 64。`mod.rs:75`
- 超限时淘汰：最近使用的 8 个受保护，优先淘汰已退出且最久未用的，否则淘汰最久未用的。`process_manager.rs:1723-1795`
- 被淘汰的进程被终止，不是静默丢弃。`process_manager.rs:1294-1298`
- 进程 ID 回收后可再分配；读取时会用 `Arc::ptr_eq` 校验句柄身份，旧引用拿到的是 `UnknownProcessId`。`process_manager.rs:929-936`
- 清理有两条路径：会话关闭时 `terminate_all_processes` 终止全部；`Op::CleanBackgroundTerminals` 可提前关掉所有后台终端。`codex-rs/core/src/session/handlers.rs:64-65`、`codex-rs/core/src/session/handlers.rs:313-317`、`process_manager.rs:1796-1812`

## 8. 超时与取消

- 交互模式没有命令级超时，`yield_time_ms` 只限制等待。
- 一次性模式有 `timeout_ms`，到点终止；超时退出码固定 124。`codex-rs/core/src/unified_exec/process.rs:212-220`
- 取消 turn 会取消 `cancellation_token`，一次性模式杀掉刚发布的进程句柄；交互模式下已交付的会话继续存活。`codex-rs/core/src/unified_exec/oneshot.rs:60-100`
- 终止是终止本地进程或远端进程句柄，没有「先 SIGTERM 再 SIGKILL」的分级描述。`process.rs:244-270`

## 9. 输出预算

- 单进程保留上限 1 MiB，头尾缓冲。`mod.rs:73`
- 默认 token 预算 10000，可被策略继续压。`shell_spec.rs:47`、`mod.rs:72`
- 截断时给 `original_token_count` 与省略标记。`unified_exec/output.rs:36-62`
- 输出事件单块 8 KiB。`async_watcher.rs:46`
- 进程退出后最多再等 50 ms 等输出关闭，避免丢尾部。`process_manager.rs:1578`、`process_manager.rs:1640-1660`

## 10. 边界与已知坑

- 非 TTY 里 `write_stdin` 发普通字符直接报错，只有 Ctrl-C 有特殊语义。这一点在工具描述里没有写明。
- 空轮询最短 5 s。想更快看到结果只能等命令退出。
- 进程被淘汰会终止，仍然活着的长任务可能因为开了太多会话而消失。
- 退出事件只进前端与记录，不进模型上下文；模型重新进入时只能靠再次轮询。
- 远端环境中 `OutputDrainPolicy::WaitForOutputClosure` 会把输出留在可轮询状态，即使进程已退出。`process_manager.rs:1149-1200`
- 输入审批有体积上限，超限直接拒绝而不是截断执行。`process_manager.rs:944-975`

## 11. 已知空白

- 没有考察 TUI 侧如何呈现 delta 与 `ExecCommandEnd`。
- 没有考察多个环境（`environment_id`）下进程表是否分片。
- 没有实机验证模型在长命令后是否真的会主动轮询，只确认代码不提供自动唤醒。
