# 模型可见提示词的设计规则

本文记录 `bash` / `bash_task` 提示词的层间分工、已固定的措辞及理由。改提示词前读本文，再读 [四家原文汇编](.scratch/async-bash-research/prompts.md)。当前文本见 [C 稿](.scratch/bash-task-handoff/prompt-c-reviewed.md)，基线见 [A 稿](.scratch/bash-task-handoff/prompt-a-current.md)，初稿见 [B 稿](.scratch/bash-task-handoff/prompt-b-proposed.md)。

## 1. 四层的可见性

| 层 | 出现在哪 | 只该写什么 |
|---|---|---|
| `promptSnippet` | 直接模式下进 `<tools>` 清单，一行 | 帮助选择工具的动作短语。模型看不到的工具不该出现在这里 |
| `description` + `parameters` | 直接模式下进 `tools[]`；codemode only 模式下追加到 `codemode` 工具描述 | 调用契约：时序、返回字段、上限、参数语义 |
| `promptGuidelines` | `<rules>` 段，平铺，无工具名前缀 | 行动和理由。每条必须点名工具，不能写 "this tool" |
| 工具结果与完成消息正文 | 交接回执、`bash_task` 结果、`custom_message` | 当场决策需要的事实和一句动作 |

Pi 文档按此顺序使用这四层，见 `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` 的 "Custom Tools" 与 "Overriding Built-in Tools" 段。**覆盖内置工具时 `promptSnippet` 与 `promptGuidelines` 不继承**，必须在覆盖定义里重写，否则清单和规则会静默消失。

实测：`codemode` only 模式会把 snippet、`description`、`promptGuidelines`、参数类型声明一起并进 `codemode` 的工具描述，`bash` 自己不出现在 `tools[]`。改任何一层都要同时检查两种模式，`test/instructions.test.mjs` 已覆盖。

## 2. 两条写作原则

**解释机制，不只下命令。** 每条行为规则要给出可推断后果，模型遇到没列举的情形才能自己判断。例如不是「不要轮询」，而是「Pi 已在跟踪，`sleep` 会占住当前调用，命令结束后仍要等它返回」。四家对照里 OpenCode 和 Amp 都写了理由，Codex 没有规则层，是最明显的反证。

**重复要落在决策点。** 事实只写一次：交接触发与返回字段、自动送达、预览上限、`timeout` 的进程寿命、`wait_seconds` 的调用寿命。重复的是「刚拿到 `running` 时该做什么」这类动作句，因为模型此刻才需要它。因果解释只出现一次，回执里重复因果会挤掉事实。

## 3. 已固定的措辞，不要改回

| 决定 | 理由 |
|---|---|
| 用 `Inspect a handed-off Bash task or wait on it`，不用 `briefly` | 能力是 0–300 秒，`briefly` 与参数事实冲突。范围只写在参数里，清单给建议语气 |
| `Inspect` 在前，`wait` 在后 | `wait for its result` 会让模型把主动等待当成取结果的常规途径，与自动送达冲突 |
| 阻塞门槛写「用户明确要求当前调用阻塞」 | 「这次调用需要退出结果」覆盖所有构建和测试，会把主动等待变回默认 |
| `sleep` 的后果写成「可能让命令结束后还要继续等」 | 只有占住工具调用的调用才推迟模型看到结果。`bash_task` 的等待 `race(task.done)`，任务一结束就返回，不构成延迟 |
| 不写「结束整段回复才会送达」 | 忙时在 `turn_end` / `agent_before_settle` 追加，空闲由 `sendMessage({triggerTurn:true})` 开新轮。送达闸门是工具调用边界，不是整段回复 |
| 不写「用某个工具停止任务」 | 模型没有 kill 工具，`/bash-stop` 是用户斜杠命令。规则只让模型报出 `task_id` |
| `timeout` 描述写明「达到时限会终止命令」 | 它改变命令后果，必须写。寿命与 `wait_seconds` 分开表述 |
| 不把「`timeout` ≤30 秒时不起交接定时器」写进参数 | 会把 `timeout` 诱导成阻塞开关。该事实留在 `SPEC.md` 和代码 |
| 清单与回执统一用 `handed-off` / `task` | 与 `task_id`、`Bash task ...` 回执、`bash_task` 名字互相对应，省掉术语解释 |

## 4. 未采用：`handoff: false` 同步阻塞

完整提案（清单、描述、参数、规则、代价）在 [C 稿末节](.scratch/bash-task-handoff/prompt-c-reviewed.md#可选提案--同步阻塞)。当前结论是先不做。

- 现状已有一条阻塞路径：`timeout` ≤30 秒时不交接，命令跑到结束或被杀；`bash_task` 也能阻塞到 300 秒。
- 布尔开关容易被泛化，模型可能对每个慢命令都关闭交接，回到长命令占满一轮。
- 关闭交接后没有 `task_id`、没有 `/bash-stop`、退出后日志被删、没有完成通知。
- 重新评估的触发条件：出现可复现的场景，需要**同一次工具调用**取到终态，且结束本轮等自动接续或在已有任务上有界等待都不够用。普通测试跑 40 秒只说明多一次接续，不构成理由。

## 5. 验证方法

1. `npm run check` 与 `npm test`。20 项约 75 秒，含真实 RPC 用户旅程与 OpenAI 适配器请求前缀回归。
2. 用 `test/instructions.test.mjs` 输出的 `tool-instructions.json` 核对真实请求：断言每段 `promptSnippet`、`promptGuidelines`、`description`、参数描述都出现在捕获的系统消息或 codemode 描述里，同时出现在 C 稿和 `flow-simulation.html` 的中英对照里。
3. 改提示词后必跑 `test/cache-prefix.test.mjs`：任务事件期间已有消息、系统提示和工具声明必须保持不变。

边界：真实模型的遵循程度未验证，只做过隔离场景抽查；Linux 未实测。`npm test` 的缓存断言只看 OpenAI 适配器序列化后的请求。

## 6. 参考

- 四家逐字原文（Codex、OpenCode、Amp、Unreal Agent，带 `文件:行号` 与版本锚点）：[`.scratch/async-bash-research/prompts.md`](.scratch/async-bash-research/prompts.md)
- 机制与复杂度对照：[`.scratch/async-bash-research/comparison.md`](.scratch/async-bash-research/comparison.md)
- 中英对照与消息流：[`.scratch/bash-task-handoff/flow-simulation.html`](.scratch/bash-task-handoff/flow-simulation.html)
- sleep 轮询与会话延迟的实测证据：[`SLEEP_POLLING_INVESTIGATION.md`](SLEEP_POLLING_INVESTIGATION.md)
