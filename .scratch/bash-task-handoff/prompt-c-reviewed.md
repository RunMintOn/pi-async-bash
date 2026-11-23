# C · 评审后的提示词

本稿以 [A · 当前提示词](prompt-a-current.md) 和 [B · 初稿](prompt-b-proposed.md) 为基础。Peer Reviewer 以 High 完成四轮分项评审和一轮全稿检查。第 1 至 4 节可用于现有接口。同步阻塞的完整候选放在末节，供单独决策。

## 1. 工具清单

```text
- bash: Run Bash commands with background handoff for long-running commands
- bash_task: Inspect a handed-off Bash task or wait on it
```

工具清单只帮助选择。第一条说明命令可以转到后台，第二条把「查看已有任务」放在首位。两处沿用 `handoff` 和 `task`，与 `task_id` 和回执里的 `Bash task` 对应。具体的 30 秒放在描述里。B 的 `wait for its result` 容易让模型把主动等待当成取结果的常规途径。

## 2. 工具描述与参数

`bash`

```text
Run a Bash command in the current working directory. If it finishes before handoff, return its stdout and stderr. The text result keeps at most the last 2,000 lines or 50 KiB, whichever limit is reached first. If truncated, the full output is saved to a temporary file. If the command is still running after 30 seconds, hand it off and return status: running, task_id, and log_path. The same command keeps running, and Pi delivers its final result to the original conversation automatically.
```

| 参数 | 类型 | 候选原文 |
|---|---|---|
| `command` | string，必填 | Shell command to execute. |
| `timeout` | number，可选 | Maximum command runtime in seconds, including after handoff. Reaching this limit terminates the command. Omit for no timeout. |

`bash_task`

```text
Inspect or wait on the handed-off Bash task identified by task_id. Returns its status, exit code when available, log path, and a preview of up to 40 lines and 4 KiB with original line numbers. An already finished task returns immediately. Reaching the wait limit or cancelling the wait leaves the command running. If this call delivers the final result directly to the model, Pi skips the separate completion message.
```

| 参数 | 类型 | 候选原文 |
|---|---|---|
| `task_id` | string，必填 | Task ID returned by bash at handoff. |
| `wait_seconds` | number，可选，0–300 | Maximum time this call waits for the task to finish, in seconds. Use 0 for an immediate snapshot. Accepts 0 to 300. Defaults to 30. |

借 Codex 和 Amp 对等待窗口的说明，把进程寿命和一次调用的等待时间分开。`timeout` 到期会终止命令。`wait_seconds` 只控制本次调用，会在任务先结束时提前返回。现有 `wait_seconds` 默认值仍是 30 秒，所以规则明确要求查进度时传 `0`，用户明确要求阻塞时也传入具体秒数。交接后的终态和日志预览使用 `bash_task` 的格式。原生输出截断规则适用于交接前完成的调用。

## 3. 系统规则

Pi 内置的 `Use bash for file operations like ls, rg, find` 和从原生 `bash` 继承的 `You can inspect PI_* environment variables for current model and session details.` 照常保留。

`bash` 的新增规则

```text
- When bash hands off a command, running means the original command is still executing. Pi tracks it and automatically delivers the final result to this conversation. Continue work that can proceed without it. If all remaining work depends on the result, end your turn; Pi will resume the conversation when the result is ready. Do not rerun the command just to get its result, since that can repeat its side effects.
```

`bash_task` 的新增规则

```text
- Do not poll handed-off Bash tasks for completion by sleeping, repeatedly reading logs, or repeatedly calling bash_task. Pi already tracks completion. A sleep call can keep you waiting even after the command has finished.
- Use bash_task with wait_seconds: 0 if output already produced can inform an action now, or if the user asks for progress. If the user explicitly asks to block on an existing task, make one bounded bash_task call with an explicit wait_seconds. If it returns running, leave completion to Pi.
```

OpenCode 把禁令和查日志的正当用途写在一起，Pi 沿用这个结构。Amp 解释了反复等待的成本，Pi 的具体机制是运行中的 `sleep` 工具调用可能推迟模型看到已完成的结果。`bash_task` 等待会随任务结束而返回。Pi 忙时能在当前工具调用后的边界送达，空闲时能自动开启新一轮。提示词无需把送达表述成必须等整段回复结束。

Unreal Agent 把结束本轮写成等待的一种做法，Pi 一并告诉模型接下来会发生什么。Codex 的会话 ID 用于后续主动交互，Pi 的任务 ID 用于向已存在的任务查进度或应请求等待。知道 ID 后，为了取结果重跑原命令既多余，也可能重复执行副作用。

评审建议放宽正时长等待条件到「这次调用需要退出结果」。本稿保留更窄的条件。常规测试和构建都需要退出结果，而结束本轮后能在原会话接着处理。用「明确要求当前调用阻塞」才能把这两种意图区分开。参数描述交代工具能力，行为规则约束模型何时用这项能力。

## 4. 交接回执

`bash` 首次交接的候选文本

```text
Bash task <task_id> is still running.
Log: <log_path>
Pi will deliver the final result to this conversation automatically. Continue independent work, or end your turn to wait.
```

OpenCode 在交接时重复行为规则，Unreal Agent 把下一步直接放进占位结果。Pi 在这里重复「会送达」和「可以结束本轮」，对应模型刚拿到 `running` 时的选择。`sleep` 的成本、读取日志的例外和参数细节都由前文解释。

`bash_task` 再次返回 `running` 时沿用当前的状态、路径及可用的预览。用户刚问过进度时，这条回执直接给出进度。终态通知和直接查询终态仍复用同一格式。退出码、日志路径、预览的行号和截断标记用来判断结果以及是否需要读完整日志。嵌套调用向脚本返回结构化值，首次交接的动作提示属于直接调用的文本回执。

## 可选提案 · 同步阻塞

建议先采用前四节。推动这个可选提案的条件是出现一类明确需要**同一次调用**取得终态的任务，并且结束本轮等自动接续、或在已有任务上做一次有界等待，无法满足该需求。有一个可复现的场景，就可以据此评估。普通测试跑 40 秒只说明会多一次接续，仍需权衡它和长时间占用工具调用的代价。

若决定支持，在 §1 的 `bash` 清单和 §2 的 `bash` 描述里加上默认行为的限定，新增 `handoff` 参数，并补上一条 `bash` 规则。§3 中关于已交接任务的规则继续适用。

`bash` 的工具清单

```text
- bash: Run Bash commands, with background handoff by default for long-running commands
```

`bash` 的描述替换 §2 最后两句

```text
By default, if the command is still running after 30 seconds, hand it off and return status: running, task_id, and log_path. The same command keeps running, and Pi delivers its final result to the original conversation automatically.
```

| 参数 | 类型 | 候选原文 |
|---|---|---|
| `handoff` | boolean，可选 | Defaults to true. Set to false to keep this call open until the command exits, times out, or is cancelled. No task ID or separate completion message is produced when handoff is false. |

`bash` 的附加规则

```text
- Use bash with handoff: false only when the user explicitly asks the current call to stay open until the command finishes. For an ordinary request to report the result when it is ready, omit handoff so Pi can resume the conversation automatically.
```

选 `handoff: false` 是因为它直接指出关掉的行为。`sync: true` 容易被理解为「这次要拿结果」，而两条路径都会送达终态。`timeout` 仍限制命令总运行时间。同步调用没有已交接的任务可供 `bash_task` 或 `/bash-stop` 使用。

若采用，更新 `SPEC.md`，验证省略参数仍交接、关闭交接按原生结果返回、超时和取消仍生效，以及关闭交接时没有后台任务或完成通知。用 `test/instructions.test.mjs` 核对模型请求中的静态文字，用 `test/rpc.test.mjs` 核对交接回执和执行行为，用 `test/cache-prefix.test.mjs` 核对任务事件期间的缓存前缀。行为上应再看四个场景。

| 场景 | 预期 |
|---|---|
| 测试交接，剩余工作都依赖结果 | 结束本轮并由完成消息接续，不重跑 |
| 用户问目前输出 | 用已有 `task_id`，传 `wait_seconds: 0` |
| 用户明确要求新命令在当前调用里等完 | 采用同步提案时，设 `handoff: false` |
| 用户要求阻塞等待已交接的任务 | 用已有 `task_id` 做一次有界等待 |
