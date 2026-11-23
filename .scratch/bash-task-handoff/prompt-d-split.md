# D · 三个工具的分工

本稿取代 [C 稿](prompt-c-reviewed.md) 中「可选提案 · 同步阻塞」的结论。C 稿保留为上一版的记录，`git show 4c2555b` 是那一版的实现。

## 1. 分工

| 工具 | exposure | 默认直接声明 | 脚本里调 | 契约 |
|---|---|---|---|---|
| `bash` | `model-only` | 能 | 不能 | 30 秒交接，返回 `status: running`、`task_id`、`log_path` |
| `bash_sync` | `codemode` | 不能 | 能 | 阻塞到退出，返回原生 `output`、`truncated`、`full_output_path`、`exit_code`、`wall_time_seconds` |
| `bash_task` | `model-only` | 能 | 不能 | 查看或等待已交接任务 |

`bash_sync` 沿用原生 Bash 的输出和截断处理。后台任务的 ID、日志、状态栏、完成通知和 `/bash-stop` 归 `bash` 的交接流程。

分工的理由：脚本本身已经能循环和并发，脚本里再拿到 `task_id` 就是两层调度。同步不是开关参数，是另一个工具，模型不需要判断该不该打开。

## 2. 工具清单

```text
- bash: Run Bash commands with background handoff for long-running commands
- bash_task: Inspect a handed-off Bash task or wait on it
```

`bash_sync` 不出现在清单里，它是 `codemode` exposure，只列在 codemode 描述中。C 稿第 1 节的取舍继续适用。

## 3. 工具描述与参数

`bash` 与 `bash_task` 的描述、参数文本沿用 C 稿第 2 节，不加不改。

`bash_sync`

```text
Run a Bash command in the current working directory and wait for its result, including on nonzero exit. Returns output, truncated, exit_code, wall_time_seconds, and full_output_path when the structured output is truncated. The command timeout and the script deadline apply when set. The script occupies a codemode worker while it waits. Use bash directly for long-running commands that can be handed off.
```

| 参数 | 类型 | 原文 |
|---|---|---|
| `command` | string，必填 | Shell command to execute |
| `timeout` | number，可选 | Timeout in seconds (optional, no default timeout) |

参数沿用原生文本。`bash` 那份把 `timeout` 写成「包括交接后」并说明到期会终止命令，因为交接改变了调用的寿命。`bash_sync` 没有交接，原生的说法就是准确的，不需要加限定。

worker 数量由 Pi 配置决定。描述说明等待会占用一个 worker，并提示可独立运行的长命令走交接。

## 4. 系统规则

`bash` 的规则在 C 稿三条基础上增加一条。

```text
- In codemode scripts, use tools.bash_sync to run shell commands.
```

加这条是为了让模型在编写脚本时看到可直接使用的调用名。

`bash_task` 的规则沿用 C 稿两条，不做改动。

`bash_sync` 没有 `promptGuidelines`。它不在 `<rules>` 里出现，而 codemode 描述已经带上调用契约和 worker 代价，再加规则只是重复。

## 5. 未采用

**摘掉 Pi 的默认 `bash`，把模型侧改名。** 技术上可行，实测 `session_start` 里 `pi.setActiveTools` 过滤 `bash` 之后，模型侧的声明就不再包含它，并且跨轮保持。放弃的原因是它只换来根词自由，而代价是 `--tools` 同时充当注册白名单：显式点名 `bash` 时替换工具会被整个摘掉，模型手上一个 shell 都不剩。今天 `--tools read,bash` 照常可用。

**布尔开关 `handoff: false`。** C 稿末节与 `PROMPT_DESIGN.md` 第 4 节的理由仍然成立：开关容易被泛化，模型可能对每个慢命令都关掉交接。这次用工具名而不是参数表达同一件事。

**`shell` 作为根词。** 这个工具实际跑的是 `settings.shellPath`，叫 `bash` 在 zsh 或 pwsh 下名不副实。不采用是因为包名 `pi-async-bash`、实现 `createBashToolDefinition`、全篇文档都叫 bash，只换工具名会让项目身份分裂。
