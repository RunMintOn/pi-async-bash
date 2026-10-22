# 模型说明逐条对应

Codex 来源：本地仓库 commit `c22a06c18070c3e33bd2648c7210a00a2a9f6f80`。工具定义来源 `codex-rs/core/src/tools/handlers/shell_spec.rs`，模型指令来源 `codex-rs/models-manager/models.json`，代码单元等待模板来源 `codex-rs/code-mode-protocol/src/description.rs`。这里只迁移与当前插件相关的规则，不把某个模型版本的完整指令推广为所有 Codex 会话的统一提示词。

Pi 来源：`@earendil-works/pi-coding-agent` 1.4.0，公开 `createBashToolDefinition`。这里的 Schema 指 description、输入 Schema 与输出 Schema；Snippet 和 Guidelines 是 Pi 系统提示词的贡献字段，Codex 没有同名的必填组织方式。

## Codex 原文、取舍与位置

| 来源 | 原文 | 取舍及最终位置 |
| --- | --- | --- |
| Shell 工具 description | “Runs a command in a PTY, returning output or a session ID for ongoing interaction.” | bash description 保留句式，改为 shell command，避免暗示默认有 PTY；补充 write_stdin 接续入口、本插件输出上限与初次取消语义 |
| cmd 字段 | “Shell command to execute.” | 原样用于 command 字段 |
| workdir 字段 | “Working directory for the command. Defaults to the turn cwd.” | 按用户最新决定不保留该字段；使用 cd，不为等价能力新增入口 |
| tty 字段 | “True allocates a PTY for the command; false or omitted uses plain pipes.” | 原样用于 tty 字段 |
| exec yield 字段（Unix） | “Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.” | 原样作为 bash yield_time_ms 说明主体；补充提前完成、没有执行 timeout，避免将等待上限当成运行时限 |
| write_stdin description | “Writes characters to an existing unified exec session and returns recent output.” | 改 unified exec 为 command；recent 明确为 only new，符合增量契约；保留本插件取消只结束等待的事实 |
| session_id 字段 | “Identifier of the running unified exec session.” | 说明为 bash/write_stdin 实际返回的命令引用；不称为 OS PID |
| chars 字段 | “Bytes to write to stdin. Defaults to empty, which polls without writing.” | Bytes 改 Characters，匹配 JSON string；保留空输入轮询，补充 PTY Ctrl+C 与管道普通字符的区别 |
| stdin yield 字段 | “Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.” | 字段说明明确分开非空 250–30000 ms、空 5000–300000 ms，以及各自默认值；补充完成提前返回，不改运行时间 |
| 模型目录中多个配置的执行规则 | “Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.” | 原样进入 bash Guidelines。建议不改变参数能力上限，不新增硬性执行超时 |
| 模型目录的命令引用规则 | “Treat shell command text as code. `JSON.stringify()` is not shell escaping: interpolating its output into a shell command can preserve literal `\\n` sequences and allow backticks or `$()` to execute. Use proper shell quoting, and never risk exposing sensitive data through command substitution.” | bash Guidelines 保留核心操作要求：Treat shell command text as code. JSON.stringify() is not shell escaping; use proper shell quoting. 不复制产品无关的工具名细节 |
| 模型目录中的 exec_command 引用警告 | “Exercise caution when escaping text for exec_command calls - backticks and `$()` passed to the `cmd` argument will still execute. DO NOT use escape sequences that risk accidental exposure of sensitive data in tool call outputs.” | 与上一条合并为一个 shell quoting 指引，避免重复；不保留不存在的 cmd 字段名 |
| gpt-5.5 的持续执行规则 | “Do not end your turn while `exec_command` sessions needed for the user’s request are still running.” | 调整为本插件实际行为：没有完成通知或自动唤醒；用户任务依赖结果时继续 write_stdin。进入 write_stdin Guidelines，仍允许先做独立工作 |
| 代码单元 wait 模板 | “Use `wait` only after `exec` returns `Script running with cell ID ...`.” | 只迁移“使用实际交付的引用接续”的意图；write_stdin Guidelines 要求沿用 bash/write_stdin 返回的 session_id，不因窗口到期重新执行 |
| 代码单元 wait 模板 | “`wait` returns only the new output since the last yield, or the final completion or termination result for that cell.” | 适用的增量输出语义放入 write_stdin description；不复制 cell 生命周期 |
| 代码单元 wait 模板 | “If the cell is still running, `wait` may yield again with the same `cell_id`.” | 迁移同一引用继续等待的意图，使用 session_id；不新增 exec/wait 或 cell_id |
| 代码单元 wait 模板 | “If the cell has already finished, `wait` returns the completed result and closes the cell.” | 不迁移 closes the cell：本插件保留终态供重复读取，避免与已确认契约冲突 |
| 代码单元 wait 参数 | “`terminate: true` stops the running cell; false or omitted waits for output.” | 不复制。停止由用户 /bash-stop 提供，write_stdin 取消不杀进程 |
| Shell 其余可选字段 | shell、login、max_output_tokens、environment_id 与审批字段的各自说明 | 不迁移字段及专属指令；这些能力不在当前契约内，不因参考 Codex 扩大 Schema |

## Pi 原生说明

| 项目 | 原生 | 插件 |
| --- | --- | --- |
| bash Snippet | Execute bash commands (ls, grep, find, etc.) | 通过公开定义直接复用 |
| bash Guidelines | You can inspect PI_* environment variables for current model and session details. | 通过公开定义直接复用，再增加上述适用的 Codex 两条执行建议 |
| write_stdin Snippet | 无此原生工具 | Send input to a command session or wait for new output |
| write_stdin Guidelines | 无此原生工具 | 同一引用接续、不因等待到期重启；没有完成通知，任务需要结果时继续等待 |
| 公共文件操作规则 | Use bash for file operations like ls, rg, find | 保留 Pi 根据工具名生成的规则，插件不重复添加 |

没有新增 sleep、轮询或 Shell timeout 的一概禁令。提示词中的“没有执行 timeout”只描述工具能力，不限制用户在 command 中使用系统限时命令。

## 实际上下文验证

真实 AgentSession 经本地 provider 取得请求中的 system message 与 toolsAdded；没有调用真实模型 API。

- 直接调用模式：两个 Snippet 出现在系统提示词工具列表，环境和等待规则出现在规则区；Schema 不含 workdir。
- codemode-only 模式：Pi 按其原生规则隐藏两个直接声明，将工具 Guidelines 合入 codemode 工具描述与可发现声明；验证这些规则没有因隐藏而丢失。使用公开 createCodemodeExtension，不自行重写宿主的提示词路由。
- 输入、输出 Schema 从会话最终注册定义取得；输出新增元数据也经真实工具调用及 RPC codemode 验证。
- 完整原生/插件定义与请求保存在测试输出列出的 tool-instructions.json 中；可读的字段前后对比另附 tool-interface-diff.md。
- 红灯：`/tmp/async-refine-instructions-red.log`；修复后：`/tmp/async-refine-instructions-green.log`。
