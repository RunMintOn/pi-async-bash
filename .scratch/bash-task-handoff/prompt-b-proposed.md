# B · 提示词初稿

以 [A](prompt-a-current.md) 为基线。以下英文是候选文本。30 秒交接和现有 `bash_task` 等待范围沿用当前实现。带 `handoff: false` 的文字是可选同步阻塞提案，采用时需同步更新工具参数和运行行为。

## 1. 工具清单

```text
- bash: Run shell commands with automatic handoff after 30 seconds
- bash_task: Inspect a handed-off bash command or wait for its result
```

两行分别回答「如何启动」和「如何查看已有任务」。Codex 把交接后的交互写进 `exec_command` 和 `write_stdin` 的描述。Pi 单独有清单，适合保留一行选择提示。

## 2. 工具描述与参数

`bash`

```text
Run a Bash command in the current working directory. If it finishes before handoff, return its output and exit result. Output is truncated to the last 2,000 lines or 50 KiB, whichever limit is reached first, with the full output saved to a temporary file. By default, if the command is still running after 30 seconds, return status: running, task_id, and log_path. The same process continues in the background.
```

| 参数 | 类型 | 候选原文 |
|---|---|---|
| `command` | string，必填 | Shell command to execute. |
| `timeout` | number，可选 | Maximum command runtime in seconds, including after handoff. Omit for no timeout. |
| `handoff` | boolean，可选，提案 | Defaults to true. Set to false to keep this call open until the command exits, times out, or is cancelled. With false, no background task is returned. |

`bash_task`

```text
Inspect or wait for the existing command identified by task_id. Returns its status, log path, exit result if finished, and a log preview of up to 40 lines and 4 KiB with original line numbers. A finished task returns immediately. Reaching the wait limit or cancelling the wait leaves the command running. If this call delivers the final result directly to the model, Pi skips the separate completion message.
```

| 参数 | 类型 | 候选原文 |
|---|---|---|
| `task_id` | string，必填 | Task ID returned by bash at handoff. |
| `wait_seconds` | number，可选，0–300 | Maximum time this call waits for the task to finish, in seconds. Defaults to 30. Set to 0 for an immediate snapshot. |

借 Codex 对等待窗口的精确定义，也借 Amp 对「等现有进程」的说明。把进程总时限、单次等待时限和是否交接放在各自的参数上。参数讲行为，什么时候该用由系统规则统一解释。

## 3. 系统规则

现有 `Use bash for file operations like ls, rg, find` 和 `You can inspect PI_* environment variables for current model and session details.` 照录。扩展新增的行为规则候选如下，末条属于同步阻塞提案。

```text
- When bash returns a running task, the original command is still executing. Pi tracks it and delivers the final result to this conversation automatically. Continue work that can proceed independently. If all remaining work depends on the result, finish your turn; the completion message will resume the conversation. Do not rerun the command to obtain its result, since that can repeat its side effects.
- Do not poll a handed-off bash task for completion with sleep, repeated log reads, or repeated bash_task calls. Pi already tracks completion, and a pending check can delay delivery of the result. Use bash_task with wait_seconds: 0 when current output can inform an immediate action or the user asks for a progress check.
- Use bash with handoff: false only when the user explicitly asks this call to stay open until the command finishes. An ordinary request to report the result when it is ready can use automatic handoff. If a task has already been handed off and the user explicitly requests a blocking wait, use bash_task with a bounded wait on the existing task.
```

OpenCode 的禁令限定在「为确认是否完成而轮询」，并给出查日志的正当用途。Amp 说明空转等待有调用成本，也把 `running` 写成正常状态。Unreal Agent 把结束本轮变成明确可选动作。Pi 自己在工具调用返回后的边界送达结果，所以理由写成「等待中的检查可能延迟结果送达」。显式阻塞仅在用户需要当前调用持续等待时启用，防止模型把普通的结果依赖也当成关闭交接的理由。

## 4. 交接回执

`bash` 首次交接时的候选文本

```text
Bash task <task_id> is still running.
Log: <log_path>
Pi will deliver the final result automatically. If no independent work remains, end your turn.
```

OpenCode 在后台返回时重复交代下一步。Unreal Agent 用一句占位结果传达同样的动作。这里重复「自动送达」和「可以结束本轮」，因为模型刚收到 `running`，正需要决定怎么做。`bash_task` 的状态和完成通知保留 A 的格式。回执正文面向直接看到该文本的模型。结构化交接结果仍是 `status`、`task_id` 和 `log_path`。
