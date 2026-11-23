# A · 当前模型可见提示词

基线是 `experiment/bash-task-handoff` 的 `626630f`，Pi 1.6.0。第 1 至 3 部分逐字摘自 `node --test test/instructions.test.mjs` 捕获的系统消息分段与工具声明。第 4 部分摘自 `index.ts` 的回执模板，尖括号内为样例值。范围为本扩展的两项工具和相关原生提示，另列一条直接相关的 Pi 内置规则。

## 1. 工具清单

```text
- bash: Execute bash commands, handing off long-running commands after 30 seconds
- bash_task: Inspect or briefly wait for a handed-off bash task
```

## 2. 工具描述与参数

`bash`

```text
Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. The timeout limits the command's total runtime, including time after handoff. If the command is still running after 30 seconds, bash returns status: running, task_id, and log_path while the same process continues. Pi delivers the final result to the original conversation automatically.
```

| 参数 | 类型 | 参数原文 |
|---|---|---|
| `command` | string，必填 | Shell command to execute |
| `timeout` | number，可选 | Timeout in seconds (optional, no default timeout) |

`bash_task`

```text
Inspect or wait for a task handed off by bash. Returns its status, exit result if finished, log path, and a preview capped at 40 lines and 4 KiB with original line numbers. A finished task returns immediately. Expiring or cancelling the wait leaves the command running. When bash_task delivers the final result directly to the model, Pi skips the completion message.
```

| 参数 | 类型 | 参数原文 |
|---|---|---|
| `task_id` | string，必填 | Task ID returned by bash. |
| `wait_seconds` | number，可选，0–300 | Maximum time to wait in seconds, from 0 to 300 (default 30). Use 0 for an immediate snapshot. |

## 3. 系统规则

```text
- Use bash for file operations like ls, rg, find
- You can inspect PI_* environment variables for current model and session details.
- When bash hands off a command, continue work that can proceed without its result. If nothing else can proceed, finish your turn; the completion message will resume the original conversation. Rerunning the command can repeat its side effects.
- Use bash_task with wait_seconds: 0 when the current log can inform useful work now. Wait briefly when your current tool call needs the exit result. Repeated waits or log checks just to learn whether bash finished keep the agent busy while Pi already tracks completion.
```

第一条由 Pi 提供。第二条由扩展从原生 `bash` 继承。后两条分别挂在 `bash` 和 `bash_task` 的 `promptGuidelines`。实测 `codemode` 的 only 模式把后面三条和工具描述、类型声明一起放进 `codemode` 的工具描述。前面的工具清单来自直接调用模式。

## 4. 交接回执

`bash` 首次交接时的文本

```text
Bash task <task_id> is still running.
Log: <log_path>
```

`bash_task` 再次返回运行中时的文本

```text
Bash task <task_id>: running.
Log: <log_path>
```

后者有日志可显示时追加行号和内容。`bash` 首次交接还提供机器可读的 `{status: "running", task_id, log_path}`。完成通知复用 `bash_task` 的结果格式，例如 `Bash task <task_id>: exited with code 0.`，随后是日志路径和可用的预览。
