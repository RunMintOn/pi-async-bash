# Bash 自动交接与原会话接续

本规格以 Pi 1.6.0 为基线。完整需求和验收记录见 [T11](.scratch/bash-task-handoff/issues/01-bash-task-handoff.md)。

| 接口 | 约定 |
|---|---|
| `bash({ command, timeout? })` | `model-only`。使用原生 Bash 执行。交互式和 RPC 会话里，命令先结束就返回原生结果，30 秒仍在运行就返回 `status: "running"`、`task_id`、`log_path`。`pi -p` 和 `--mode json` 全程使用原生前台执行。`timeout` 约束命令总执行时间。 |
| `tools.bash_sync({ command, timeout? })` | `codemode`。等待原生 Bash 的执行结果，含非零退出码。命令超时抛异常。输出超过 1 MiB 时，结构化结果中的 `truncated` 为 `true`，`full_output_path` 指向完整输出。无后台任务、交接日志或完成通知。 |
| `bash_task({ task_id, wait_seconds? })` | `model-only`。允许 0–300 秒，默认等 30 秒，零秒立即查看。等待期间命令退出就提前返回。等待到期或取消后，进程照常运行。 |
| `/bash-stop <task_id>` | 停止原会话拥有的已交接任务。同步调用不在管理范围内。 |

`model-only` 的工具由模型直接调用。`codemode` 的工具默认供脚本调用，显式激活后也会声明给模型。

`task_id` 是进程内任务表中唯一的 6 位十六进制 ID。终态的 `wall_time_seconds` 从命令启动计到执行结束。结果正文按整秒显示，不计入日志写完后等待投递的时间。

结果正文固定为四段：任务状态和耗时、`Log: <log_path>`、空行加输出标题、空行加输出预览。运行中首行是 `Bash task <task_id> is running (<n>s elapsed)`，耗时从命令启动计到查询时。终态首行是 `Bash task <task_id> <status> (<n>s total)`。没有输出预览时省略最后一段。逐行不标行号。

`bash_task` 和完成通知复用同一份结果。状态为 `running`、`exited`、`timed_out`、`stopped` 或 `failed`。正常退出返回实际 `exit_code`。`output_tail` 最多 40 行、4 KiB，优先保留整行。非空预览带 `start_line` 和 `end_line`，从 1 起算。`truncated` 表示省略了日志前缀。最后一行超限时返回完整 UTF-8 字符组成的后缀，并用 `partial_line` 标记。日志写入失败时终止命令，返回故障并标明日志不完整。结果正文的标题明确区分完整输出、截断输出、运行中输出和日志不完整。超时或停止且已捕获的输出全部展示时，标题为 `Captured output`。

终态在日志写入流结束后发布。模型直接调用 `bash_task` 并拿到终态时省去自动通知。其余完成结果追加到原会话末尾。空闲时自动开一轮，忙碌时在下一次模型调用送达。原会话未打开时保留待送结果。已完成的任务可主动重查。

任务记录保留终止原因和退出码等元数据。日志预览按需生成。原会话的任务和完整日志在当前 Pi 进程内保留。Fork 继承历史消息，任务的查询、停止和通知仍归原会话。正常退出时停止受管进程并清理扩展的临时日志。当前工具面向自行结束的命令。

==缓存验收==以 provider 适配器序列化后的请求为准。同一段历史中，交接、状态变化和完成通知保持已有消息、系统提示和工具定义稳定。完成通知只追加到历史末尾。后台状态留在任务记录和 TUI 状态栏。

此前 Codex 式交互契约可用 `git show 43fa855:SPEC.md` 查看。
