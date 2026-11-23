# 验证与串行 review

## 范围

按本轮 Spec 实施方案 A、输入与输出契约、原生复用审核、模型提示词。沿用真实 AgentSession、CLI/RPC 和本地确定性 provider；不增加内部测试接口，不调用付费模型。用户授权本轮完成后提交当前分支；不 push、发布、修改 Pi 或全局加载配置。原有未跟踪 ARCHITECTURE.md 排除在提交之外。

## 红灯与受影响回归

- workdir 参数被执行而未拒绝：`/tmp/async-refine-directory-red.log`；删除参数后工具测试通过：`/tmp/async-refine-directory-green.log`。
- 缺少本次截断元数据：`/tmp/async-refine-results-red.log`；新增行数/字节截断、完整原始日志与后续不继承历史截断的检查通过：`/tmp/async-refine-results-green.log`。
- 契约变更后受影响的执行、取消、生命周期、工具策略、RPC/codemode 与缓存前缀回归通过：`/tmp/async-refine-contract-green.log`。
- Pi 原生能找到管理目录里的命令，插件却退出 127：`/tmp/async-refine-path-red.log`；修复后管道与 PTY 均通过：`/tmp/async-refine-path-green.log`。
- 固定 50 ms 截止导致尾部输出仅交付两条 tick，原生可交付二十条及 TAIL：`/tmp/async-refine-drain-red.log`；按活动重置 100 ms 静默计时后通过，静默继承管道也能及时结束：`/tmp/async-refine-native-green.log`。
- 实际模型上下文缺少原生环境指引：`/tmp/async-refine-instructions-red.log`；直接和 codemode-only 的最终上下文检查通过：`/tmp/async-refine-instructions-green.log`。
- 补充真实调用检查：管道与 PTY 的五个 PI_* 会话/模型变量、净化显示与完整原始日志、原生及插件的真实 EACCES 启动失败均通过：`/tmp/async-refine-native-smoke.log`。

## 最终验证

- `npm test` 完整执行一次，30/30 通过，约 39.3 秒：`/tmp/async-refine-final-tests.log`。
- `npm run check` 通过：`/tmp/async-refine-final-check.log`。
- manifest 与 lock 中根依赖及 node-pty 1.1.0、Pi 1.4.0 一致；`git diff --check` 通过。
- 最终 CLI/RPC 事件、会话和 stderr：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-IfSpCh`。
- 最终信号清理产物：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-oV33C8`。
- 最终直接/codemode-only 提示词完整产物的准确路径在完整测试日志中。独立提示词回归的可检查产物：
  - `/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-test-cqGnEo/tool-instructions.json`
  - `/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-test-bvzIhU/tool-instructions.json`
- 平台：Pi 1.4.0、Node 22.23.2、macOS。Linux 未实测；不声称真实模型决策或服务端缓存命中率已验证。PTY 安装脚本与打包安装的此前证据保留在上一轮任务记录，本轮未重复安装消费者。

## Standards

- 在当前对话串行 review，没有 subagent。核对产品代码、测试、依赖、发布文件清单与记录；自有实现集中于交互管理，无新通用抽象、内部深层导入或宿主修改。
- 复用了公开接口，必要适配记录了来源和有意差异；测试使用真实会话 seam 与具体预期行为，不用内部 Map、定时器调用次数或精确耗时作为功能断言。
- 没有遗留的明确规范违例。

## Spec

- 删除 workdir 且明确拒绝；cd、前缀和会话 cwd 行为有回归。
- 输出元数据在两种工具及 codemode 中可用；截断按本次输出判断，日志保留完整原始流，整数退出码/引用语义不变，耗时包含队列等待且不累计进程生命周期。
- 原生复用对应和 Codex 提示词对应已交付；Schema/Snippet/Guidelines 的实际可见性通过真实请求检查，60 秒建议不改变等待能力范围，也没有新增 sleep/timeout 禁令。
- 保留持续 stdin、PTY、取消、进程组退出清理、reload/fork 与没有自动通知的契约。此次发现的 PATH 和输出排空差异已修复并回归。
- 没有遗留的缺失需求或未解释的行为差异；明确排除的平台、跨组清理与真实模型实验不计作通过。
