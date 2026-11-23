# Project Memory

## 2026-10-22 — 交互执行方案 A 与复用边界

- 方案 A 是用户暂定的选择：保留普通管道持续 stdin 和可选 PTY，只通过插件实现，不修改 Pi。用户重视复用原生积累的边界处理；新增通用执行框架并非目标。
- **修正**：当前实现覆盖同名 bash 并拥有自己的执行后端，并非原生 bash.execute 的异步包装。Pi 1.4.0 的公开执行接口不暴露可写 stdin 或可接续进程句柄，原生管道 stdin 为 ignore，这是保留自有后端的主要原因。
- PTY 在已有交互管理上的代码增量较小，主要额外成本是 node-pty 的原生依赖、安装与平台验证；通过 script 等命令创建终端不能顺便获得原生 Bash 未开放的后续输入通道。
- 用户选择删除 workdir，因为 cd 已能覆盖日常目录切换，不值得增加模型的输入选择；选择恢复结构化截断、日志路径与单次调用耗时，避免程序解析提示文本。最终契约见 `SPEC.md`，使用说明见 `README.md`。
- **已解决**：此前仅修改 description，遗漏了覆盖工具时丢失的原生 Snippet/Guidelines，也遗漏 Codex 模型指令中的 60 秒阻塞等待建议。Shell 进程引用与 Codex 代码单元 cell_id 不能直接混用；原文、版本、取舍及直接/codemode 可见性见 `.scratch/interactive-bash-refinement/model-instructions.md`，完整前后对比见同目录 `tool-interface-diff.md`。
- **已解决**：Shell 退出后同组子进程遗留、stdin 背压绕过等待窗口，以及本轮发现的管理命令 PATH 缺失、固定排空截止导致尾部输出丢失。复用来源与有意差异见 `.scratch/interactive-bash-refinement/native-parity.md`；红灯、回归、实际请求和串行 review 证据见同目录 `verification.md`。
- 已验证范围为 Pi 1.4.0、Node 22.23.2、macOS，完整测试 30/30；Linux 未实测，真实模型决策与服务端缓存效果未验证。此前遇到 node-pty 1.1.0 Unix spawn-helper 缺执行权限，安装修正与打包消费者验证的位置见 `.scratch/codex-exec/issues/01-execution-and-interaction.md`。
- 本轮及此前交互实现合并提交为 `43fa855`，分支为 `experiment/codex-exec`；同级 `25-async-bash-legacy` 保留旧 main 工作树。没有修改日常加载配置、push 或发布；包版本仍是 0.1.2，不能据此把已发布包视为当前实现。
- `ARCHITECTURE.md` 是本轮开始前已有的未跟踪旧实现文档，未改动、未提交；历史调查和旧任务记录不代表当前契约。本地任务沿用 `.scratch/`，没有配置远端 issue tracker；本轮三个任务及最新摘要见 `.scratch/interactive-bash-refinement/issues/` 与 `TICKETS.md` 的 T10。

## 2026-11-22 — 三家异步 shell 机制研究

- 只读对比 Codex、OpenCode、Amp 的 shell 执行链路，成果在 `.scratch/async-bash-research/`：`README.md` 索引，`codex.md`/`opencode.md`/`amp.md` 三份档案，`comparison.md` 八问对照。版本与重新抽取命令记在 `README.md`。
- 三家的异步并非同一机制：Codex 只做「不阻塞本次调用」并靠模型轮询，OpenCode 用 Job 加合成消息自动唤醒，Amp 用 pid 加调用方选择的 `mode`。Amp 的完成消息由服务端产生，bundle 里只能看到落下来的形态。

## 2026-11-23 — 提示词按分层重写，同步阻塞暂不做

- 四家逐字原文已补全为 `.scratch/async-bash-research/prompts.md`（含 Unreal Agent 与抽取命令、版本锚点）。改提示词先读它，再读根目录 `PROMPT_DESIGN.md`。
- 分层固定为：`promptSnippet` 只管选工具，`description` + 参数管调用契约，`promptGuidelines` 管行动和理由，工具结果管当场动作。覆盖内置 `bash` 时 snippet 与 guidelines 不继承，必须重写。codemode only 模式会把四层并进 `codemode` 的工具描述。
- 用户要求在提示词里说明机制而不只下命令。已落实的因果：`running` 表示原命令仍在执行；`sleep` 会占住当前调用，命令结束后还要等它返回才看到结果；`bash_task` 的等待随 `race(task.done)` 任务结束即返回，不构成延迟；送达闸门是工具调用边界（忙时 `turn_end`、空闲 `sendMessage`），不是整段回复。
- 已固定的措辞与理由见 `PROMPT_DESIGN.md` 第 3 节。最关键两条：阻塞门槛是「用户明确要求当前调用阻塞」，不是「这次调用需要退出结果」，后者覆盖所有构建与测试；清单不用 `briefly`，因为能力是 0–300 秒。
- `handoff: false` 同步阻塞只留提案，不实现。现有阻塞路径是 `timeout` ≤30 秒与 `bash_task` 有界等待；开关容易被泛化，且会丢掉 `task_id`、`/bash-stop`、日志保留和完成通知。重评触发条件写在 `PROMPT_DESIGN.md` 第 4 节。
- 验证：`npm run check` 与 `npm test` 20/20（约 75 秒），`test/instructions.test.mjs` 捕获 direct 与 codemode-only 的真实请求，`test/cache-prefix.test.mjs` 保持前缀稳定。真实模型对规则的遵循程度仍未验证。
- 未提交、未发布，包版本仍 0.1.2。Footer 计数已有 `test/footer.test.mjs` 覆盖运行中任务的范围；codemode 内部的返回值与归属整理在 `.scratch/bash-task-handoff/codemode-explainer.html`。

## 2026-11-23 — 三个工具按 exposure 分工，同步阻塞改为 `bash_sync`

- 用户定了命名：`bash`（模型侧，交接）、`bash_sync`（脚本侧，同步）、`bash_task`（模型侧，查看与等待）。`bash_sync` 是 `codemode` exposure，另两个是 `model-only`。上一条里 `handoff: false` 的结论被这次分工取代，「不做布尔开关」的判断保留。
- `codemode` exposure 在未显式激活时不直接声明。保留直接调用的 `bash`，可沿用 Pi 默认工具集中的同名入口。混合模式使用 `--tools +codemode`，这会保留 `bash_sync` 的脚本调用能力。
- 被否掉：在 `session_start` 里用 `pi.setActiveTools` 摘掉 `bash`，换取模型侧改名的自由。实测生效且跨轮保持，但 `--tools` 同时是注册白名单，点名 `bash` 时替换工具会被整个摘掉，模型一个 shell 都不剩，实测声明只剩 `read`、`edit`、`write`。
- 实测：脚本里访问 `tools.bash` 会抛错。三个 Bash 工具中，`ALL_TOOLS` 只列出 `bash_sync`。
- codemode only 模式只隐藏 `direct` exposure 的工具，`model-only` 的 `bash` 与 `bash_task` 仍然直接声明给模型。已在 README 记为已知边界，`only` 未专门适配。
- 提示词层：`bash_sync` 没有 snippet 与 guidelines，只有 description 和参数进 codemode 描述。`bash` 加了一条把脚本场景导向 `bash_sync` 的规则。
- 上一版留档：提交 `4c2555b` 与 `.scratch/bash-task-handoff/prompt-c-reviewed.md`。本轮文本在 `prompt-d-split.md`。
- 可见性规则与验证手法汇总在 `PI_TOOL_EXPOSURE.md`，修改 exposure 或可见性断言前先读。
