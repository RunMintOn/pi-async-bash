# async-bash 自测记录（2026-11-24）

在当前会话里加载 `./index.ts`，用真实命令和真实耗时验证。另有 `.scratch/dogfood/boundaries.mjs` 与 `boundaries2.mjs` 直接驱动 `src/tasks.ts`，把 30 秒交接门槛替换成 60 ms，穷举预览边界。

**状态更新（2026-11-24，提交 `d01db62`）。** 标 `fixed` 的四项已修；标 `deferred` 的五项经用户决定暂缓，理由见 [PROJECT_MEMORY.md](../../PROJECT_MEMORY.md) 的 2026-11-24「自测九条发现的复核」一节。第 1 条原始表述有误，已就地更正。

## 已确认正常

- 30 秒门槛：29 秒前台返回，31 秒起交接，`timeout: 30` 阻塞到超时且不交接。
- `timeout` 在交接后继续计时：`timeout: 40` 的任务在 40 秒报 `timed_out`，总耗时口径正确。
- 前台超时、非零退出（3）、信号退出（143）、无结尾换行都与原生一致。
- 预览上限精确：32 行 4096 字节不截断，4097 字节截断并给出 `showing lines 2–32`；40 行整不截断，41 行截断为第 2–41 行；40 行 8000 字节按字节上限保留第 21–40 行。
- 多字节安全：窗口起点落在 3 字节字符中间时不产生 U+FFFD，单行 8192 字节的中文按 4096 字节后缀截断。
- 20 MB / 10 万行日志的预览在 14 ms 内完成，行号正确。
- `bash_task` 早退（600 ms 的任务用 30 秒等待，540 ms 返回）、等待取消、未知 ID、`wait_seconds` 越界校验、0 秒快照、终态复查不重复通知。
- 归属隔离：他人会话查询、停止、取完成结果都被拒绝。
- 10 个并发任务 ID 唯一且为 6 位十六进制；`shutdown` 删除日志目录。
- 空输出、仅 `\r`、CRLF、非法 UTF-8、20 万行输出（108 KB）均不崩。
- `cd` 不跨调用保留；stdin 关闭，`cat` 立即返回；脚本 `timeout_ms` 到期会杀掉子进程（无残留 `sleep`）。
- 空闲唤醒三次生效，同一轮完成的多个任务合并投递。

## 发现的问题

### 1. `bash_sync` 描述承诺的 `truncated` / `full_output_path` 没有兑现（fixed）

更正：不是「永不出现」。原生结构化输出上限是 1 MiB，恰好 1 MiB 仍为 `truncated: false`，多 1 字节才截断并给出 `full_output_path`。原判断错在把 108894 字节当成超限。真实问题是描述没写门槛。

`20000` 行、108894 字节的输出返回 `truncated: false`、`full_output_path: undefined`。实现是原生 `execute` 直通，截断发生在脚本返回值离开 codemode 时（此时才有 `Warning: truncated output ... full output path`）。工具描述与模型可见声明都在承诺不存在的字段。

影响：脚本无法判断输出规模，也无法拿到完整输出路径。建议改描述，或在 `bash_sync` 里补上真实截断。

### 2. `bash_sync` 超时抛裸 `Error`，整个脚本失败（deferred）

原生行为。`try/catch` 能保住先前的工具结果；脚本失败时 Pi 会列出此前成功的调用。改返回结构等于改宿主契约。

`tools.bash_sync({ command, timeout: 2 })` 抛出的错误只有 `message`，内容是输出加三个换行再拼 `Command timed out after 2 seconds`。异常直接终止脚本，之前已拿到的工具结果一起丢失。非零退出却返回结构化 `{ exit_code }`，两种失败形态不一致。

影响：任何带超时的脚本都得 try/catch，且只能靠文本判断是否超时。建议超时也返回结构化结果（例如 `status: "timed_out"` 加 `output`）。

### 3. `timed_out` 与 `stopped` 的结果标成 `Complete output`（fixed）

`a1a060`（40 秒超时）与 `5b018c`（31 秒超时）都输出 `timed out (...)` 配 `Complete output (0 lines)`。`formatTask` 里只有 `truncated` 分支，其余一律 `Complete output`。命令被杀掉了却写完整输出。

### 4. 运行中快照没有已运行时长（fixed）

`Bash task a806a8 is running` 只有状态，没有秒数；底部状态栏才有 `BG n · 耗时`。`wall_time_seconds` 只在终态写入。模型判断进度只能数日志行数。

### 5. 结果与通知不含命令原文（deferred）

任务记录里没有命令字段，`formatTask` 也不打印。`Bash task 354bc3 exited with code 0 (33s total)` 无法对应到 `sleep 33; python3 ...`。上下文压缩或 TUI 滚动后，用户和模型都无法把任务与命令对上，并发时更明显。

### 6. 已交接的任务记录与日志在进程内不回收（deferred）

`this.tasks` 只在 `shutdown()` 清空，`takeCompletions` 只标记 `delivered`。本次自测留下 12 个日志文件，含 0 字节的，全部保留到退出。长会话会累积磁盘与内存。

### 7. 模型没有受支持的停止入口，只有用户侧 `/bash-stop`（deferred）

`bash_task` 没有停止能力；交接后取消原工具调用也不再生效，因为调用早已返回。本次的 `while true` ticker 最终是用 `kill -TERM -<PGID>` 从外部杀掉的，状态记为 `exited with code 143 (259s total)`，不是 `stopped`。`stopped` 只由内部 abort 产生，所以外部终止无法与命令自己返回 143 区分。

影响：模型要停自己的后台任务只能靠 shell 里的 `kill`（需要先找到 PID），或者请求用户敲命令。建议给 `bash_task` 增加停止参数，或让 `bash` 暴露 task 的 PID 与进程组。

次要：`ps | grep tick` 这类找 PID 的方式会命中 `--launch-time-ticks` 等无关参数，本次一次输出 50 KB。

### 8. `bash_task` 把超时、停止当成工具失败（deferred）

`isError: status !== "running" && (status !== "exited" || exit_code !== 0)`。查看一个已超时任务的稳定终态会返回错误结果，可能触发客户端重试或错误分支。

### 9. 次要（deferred）

- 非法 UTF-8 字节被替换为 U+FFFD，未在文档说明。
- `bash_task` 没有任务列表，上下文压缩后无法按状态找回任务 ID。
- `timeout: 0` 报 `must be a finite number of seconds`（原生校验，0 是有限的）。

## 待用户验证

RPC 层的 `/bash-stop` 已由 `test/rpc.test.mjs` 覆盖（停止后状态为 `stopped`，与完成通知正文一致）。下面三项只能在 TUI 里看。

- `/bash-stop <task_id>` 的实际反馈与底部状态栏变化。
- `/bash-stop zzz` 的错误呈现。
- `/bash-stop` 一个已完成任务是否提示已经结束。

两个边界脚本 `boundaries.mjs`、`boundaries2.mjs` 可直接重跑，把交接门槛替换成 60 ms 穷举预览边界。
