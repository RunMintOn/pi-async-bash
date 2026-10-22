# Pi 原生 Bash 复用对应表

依据：本地安装的 `@earendil-works/pi-coding-agent` 1.4.0。以下路径均相对其 `dist/`。不修改宿主，不导入宿主内部模块。测试使用真实 AgentSession 和本地子进程。

| 能力 | 原生来源 | 处理与理由 | 外部验证 |
| --- | --- | --- | --- |
| Shell 选择和启动参数 | `utils/shell.js` 的 `getShellConfig` | 直接复用公开导出；不自行检测 Bash 路径、实现 login 或单次 shell 参数 | 配置 Shell、前缀及无效 Shell 回归 |
| cwd 与命令前缀 | `core/tools/bash.js` 的 `resolveSpawnContext` | 必要适配：从工具 ctx.cwd 启动，保留设置中的命令前缀；删除单次 workdir，cd 由 Shell 执行 | 带空格目录的 cd、前缀、后续 cwd 不变；拒绝 workdir |
| Shell PATH | `utils/shell.js` 的 `getShellEnv`、`config.js` 的 `getBinDir` | 原函数没有根公开导出；适配其小段 PATH 逻辑，使用公开 getAgentDir 获取 bin 目录。保留 PATH 大小写键，过滤空段，不重复添加目录 | 原生执行能找到测试管理命令；插件管道和 PTY 同样能执行。修改前插件退出 127 |
| 会话与模型环境 | `core/tools/bash.js` 的 `resolveSpawnContext` | 必要适配：清除继承的 PI_SESSION_* 等五个专属键，再按当前 ctx 填入；普通环境变量原样继承 | 当前会话、模型、前缀回归；实际环境采集检查 |
| 启动失败 | `getShellConfig`、`createLocalShellOperations` | 直接复用 Shell 配置错误；适配 spawn 的异步 error 与 PTY 同步失败，抛出工具错误，不返回假 session_id | 无效 Shell；公开工具调用的真实 spawn 失败检查 |
| 执行后端与 stdin | `createLocalBashOperations`、`BashOperations` | 有意差异：公开接口只返回 exitCode，不暴露进程/stdin，原生 stdin 为 ignore；持续输入需要自有 pipe 和 node-pty。没有重新包裹原生 execute 来绕取内部状态 | 管道输入、真实 isatty、PTY 输入和 Ctrl+C |
| 信号与取消 | `utils/shell.js` 的 `killProcessTree`、`core/tools/bash.js` | Unix 组信号做必要适配；原生辅助函数未公开导出。初次取消杀组，交接后 input 取消只结束等待，是交互契约的有意差异 | 初次取消、后续取消保留输出、显式停止、信号退出码 |
| 退出和组清理 | `trackDetachedChildPid`、`killTrackedDetachedChildren` | 必要适配：插件进程级单例、exit listener 与 quit hook；主命令退出时杀同组余留进程，不长期保存过期组 ID 用于信号 | 管道与 PTY 的主命令退出清理、RPC quit/SIGTERM |
| 输出排空 | `utils/child-process.js` 的 `waitForChildProcess` | 函数未公开导出；适配“主进程退出后，每次输出重新开始 100 ms 静默计时”的核心逻辑。移除固定 50 ms 截止。完整 close 提前结束，安静的外部继承句柄不永久阻塞 | 原生与插件同样收到全部尾部输出；旧实现仅收到两条 tick。静默继承管道及时返回 |
| UTF-8 与内存上限 | `core/tools/output-accumulator.js` | 有意适配：原生为整次执行累计流式解码；交互进程用有界日志读取与共享 cursor，保留未完成的 UTF-8 尾字节，避免重复交付。不复制整个累计器 | 大 Unicode、跨交接拆分字符、并发单次消费 |
| 输出净化 | `utils/shell.js` 的 `sanitizeBinaryOutput` | 适配相同控制字符过滤；另用 Node 标准库 stripVTControlCharacters 去掉终端控制序列。原始日志不净化；这是文本工具输出与 PTY 的有意差异 | 真实工具的净化输出与原始日志检查 |
| 截断算法 | `core/tools/truncate.js` | 直接复用公开 truncateTail 和默认字节上限 | 2,000 行与 50 KiB 上限、UTF-8、截断状态及可读完整日志 |
| 日志和结果数据 | `OutputAccumulator`、`bashOutputSchema` | 有意差异：原生超限后才创建临时日志；交互进程从启动起保留原始日志用于增量读取。结构化结果也限制到默认显示预算，不沿用原生 codemode 的 1 MiB。恢复三个元数据字段，耗时按单次 execute 计算 | 新增/空/重复读取、两种截断、完整日志、非零结构化错误、单次耗时 |
| hooks 和工具注册 | `core/extensions/wrapper.js`、AgentSession 工具注册 | 直接使用公开 registerTool；由 Pi 执行参数校验、tool_call、tool_result 与 nested calls，不私自执行模型工具 | 策略拦截、CLI/RPC codemode 及 reload/fork |
| 工具提示词 | `createBashToolDefinition` 的 promptSnippet/promptGuidelines | 通过公开原生定义复用适用的环境 Guidelines；工具简介保留原生文字并补充交互入口 | 模型接口任务验证最终上下文 |

## 限制与差异

- 第一版仍仅面向 macOS/Linux；本轮实测 macOS，Linux 未实测。Windows 是明确排除的平台。
- 自行离开进程组的后代不在停止保证内；排空测试使用短命、自行结束的外部后代，验证已有输出不被过早丢弃，不扩展为跨组进程管理。
- 公共执行接口不能提供完整持续 stdin，复制原生全部代码也不能消除这项维护责任。自有代码集中在进程与交互管理，不新增通用执行框架。
- PTY 的依赖、80×24 固定尺寸、原始回显和换行差异保留；仅在输出呈现时做文本净化。
- 无未解释的执行差异；上述有意差异不是原生全兼容承诺。模型行为、真实服务端缓存和未测试平台不属于本轮已验证结果。

## 本轮证据

- PATH 红灯：`/tmp/async-refine-path-red.log`；修改后：`/tmp/async-refine-path-green.log`。
- 排空红灯：`/tmp/async-refine-drain-red.log`。
- 原生对应及生命周期回归：`/tmp/async-refine-native-green.log`。
