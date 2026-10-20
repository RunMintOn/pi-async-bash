# 本地实施记录

集成分支：`integration/async-bash`。串行实施，不创建远端 issue 或 PR；初始实现已按用户后续要求提交为 `e16a439`。
用户已授权直接按本地 spec 实施，测试边界沿用 spec 中的真实会话与 RPC。

## T1 — 自动交接与任务控制

- 状态：已完成
- 阻塞：无
- 实现同名 bash 覆盖、固定 15 秒交接、独立执行取消、日志与状态保存。
- 实现 bash_task 的 status、wait、kill，保留 shell 设置和前台行为。
- 验证真实进程、输出协议、超时、取消与交接竞态。

## T2 — 会话生命周期与完成投递

- 状态：已完成
- 阻塞：T1
- 实现完成通知、分支状态补充、fork 引用、reload 重绑与退出清理。
- 通过真实 RPC 验证完整用户流程，保留记录。
- 补充安装与使用说明，串行执行 Standards / Spec review 并修复问题。

## 验证记录

### T4 — 移除 wait 与后台接续指引

- 状态：已完成；阻塞：无。用户已确认直接推进并在完成后提交 commit。
- bash_task 仅保留 status、kill；不增加 bash 同步等待参数，63 秒阈值和独立 timeout 不变。
- 删除指向 wait 的 guideline，后台接续指引集中放在交接结果：不要轮询，继续独立工作，否则结束当前轮次，收到通知后继续。
- 本地 ticket：`.scratch/63-second-handoff/issues/02-remove-task-wait.md`。
- 公开工具拒绝 wait 的测试先失败（旧 schema 仍接受操作），修改后通过：`/tmp/pi-async-no-wait-red.log`、`/tmp/pi-async-no-wait-green.log`。
- 完整 `npm test`：10 项全部通过，约 263 秒；真实会话及 RPC 通过自动完成通知接续，超时结果在通知后用 status 读取，不使用 wait 或轮询。日志：`/tmp/pi-async-no-wait-tests.log`。
- `npm run check`、`git diff --check` 与三个分析脚本的语法检查通过；类型检查日志：`/tmp/pi-async-no-wait-types.log`。
- RPC 可检查结果：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-fwNEjk`；崩溃恢复：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-s5ZSv3`。
- 串行 Standards / Spec 检查：对照已确认的范围与当前 spec，未发现阻碍提交的问题；保留原生 bash guidelines，删除扩展重复指引，不增加同步等待参数或兼容入口。
- 本次提交范围包含此前未提交的短 ID、63 秒阈值和相关分析报告／脚本。没有修改全局配置、相邻扩展或 WSL 文件，没有调用外部模型 API，不 push。
- 以下记录保留历史行为；T1—T3 中的 wait 支持不代表当前接口。

### T3 — 自动交接调整为 63 秒

- 状态：已完成；阻塞：无。单张本地 ticket 位于 `.scratch/63-second-handoff/issues/01-change-handoff-threshold.md`。
- 范围：固定阈值从 15 秒改为 63 秒；同步工具说明、使用文档和真实会话／RPC 测试。timeout、bash_task 操作及其他接口不变。
- 先修改公开工具行为测试，旧实现约 15 秒返回，按预期失败：`/tmp/pi-async-63-red.log`。
- 完整 `npm test`：9 项全部通过，约 263 秒；真实 63 秒交接、运行期间处理新请求、自动完成续接及原有任务生命周期均通过。日志：`/tmp/pi-async-63-tests.log`。
- 32 秒执行超时与交接取消使用可控时间、真实会话和真实子进程；独立边界检查通过：`/tmp/pi-async-63-boundaries.log`。真实 RPC 中 66 秒总执行超时没有在交接时重置。
- `npm run check` 与 `git diff --check` 通过；类型检查日志：`/tmp/pi-async-63-types.log`。
- RPC 可检查结果：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-DWVQzp`；崩溃恢复：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-5AAAgW`。
- 串行 Standards / Spec 检查：对比本次开始前的文件快照，未发现阻碍交付的问题。产品改动仅为阈值与对应说明，没有改变工具接口、短 ID 或现有任务控制行为。
- 已加载旧版本时，reload 保留原管理器，阈值升级需重启 pi；README 已说明。没有修改全局配置或安装文件，没有调用外部模型 API、使用 subagent 或提交 commit。
- 以下 15 秒与 30 秒记录保留为历史验证，不代表当前阈值。

### 阈值调整为 15 秒

- 用户在候选阈值分析后选择 15 秒；同步执行阈值、工具说明、README 和 spec。
- 先将公开工具测试改为运行 16 秒的命令，旧实现没有返回 task ID，测试按预期失败：`/tmp/pi-async-15s-red.log`。
- 更新实现后，`npm test` 8 项通过，约 68 秒：`/tmp/pi-async-15s-tests.log`。
- `npm run check` 通过：`/tmp/pi-async-15s-types.log`。
- 真实 15 秒交接、交接取消和 16.8 秒总执行超时场景均通过。
- 下方保留初版 30 秒实现的历史验证记录；本次调整未自动提交。

### 最终复验

- `npm run check`：通过。日志：`/tmp/pi-async-resume-reviewed-types.log`。
- `npm test`：8 项全部通过，约 128 秒。日志：`/tmp/pi-async-resume-reviewed-tests.log`。
- 通过真实 AgentSession 和真实 CLI/RPC，验证实际 30 秒交接、任务运行期间处理新请求、非零退出、日志保留、完成自动续接、wait 去重、取消与进程组停止。
- RPC 场景还覆盖总执行超时、reload、切会话与恢复、tree、clone 继承、codemode 结构化返回、UTF-8 尾部上限、正常退出清理和崩溃后 unknown。
- 交接取消测试使用可控时间推进，但执行和进程组清理使用真实子进程；其他长任务场景等待真实 30 秒。
- 使用本地确定性 provider，无外部模型 API 调用。没有修改用户全局配置或安装文件。

### 串行 review

当前分支没有初始 commit；审查范围为当前产品实现、测试和说明，对照 `SPEC.md` 与项目要求，未创建用于 review 的空提交。

**Standards**

- 修复最后调度边界：将发送待处理完成通知的检查从只读 `agent_settled` 移至可操作的 `agent_before_settle`。
- 产品代码保持入口与进程级管理器两个模块，复用 pi 本地 shell 后端，没有新增 daemon、阈值配置或执行工具。

**Spec**

- 修复 codemode 嵌套调用不产生独立 transcript toolResult 而导致 clone 丢失引用的问题：额外保存分支任务引用，RPC 回归通过。
- 交接决策检查取消状态；保存任务记录后才解除前台取消归属。取消交接回归通过。
- 上述最终事件边界修复后，完整测试与类型检查再次通过。

### 验证边界

- 已验证版本及平台：pi 1.3.0、Node 22.23.2、macOS。
- 没有执行真实 TUI 人工操作或外部模型行为抽查；RPC 已覆盖核心跨组件流程。
- 未穷举所有调度顺序；没有单独构造多任务恢复上下文耗尽预算的测试。
- 不承诺组合其他同名 bash 覆盖、私有执行后端或终止主动脱离进程组的后代。
- 按用户要求本地串行实施，无远端 issue/PR、无 subagent、无额外 worktree、无 commit。
