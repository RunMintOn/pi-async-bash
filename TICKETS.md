# 本地实施记录

集成分支：`integration/async-bash`。串行实施，不创建远端 issue、PR 或 commit。
用户已授权直接按本地 spec 实施，测试边界沿用 spec 中的真实会话与 RPC。

## T1 — 自动交接与任务控制

- 状态：已完成
- 阻塞：无
- 实现同名 bash 覆盖、固定 30 秒交接、独立执行取消、日志与状态保存。
- 实现 bash_task 的 status、wait、kill，保留 shell 设置和前台行为。
- 验证真实进程、输出协议、超时、取消与交接竞态。

## T2 — 会话生命周期与完成投递

- 状态：已完成
- 阻塞：T1
- 实现完成通知、分支状态补充、fork 引用、reload 重绑与退出清理。
- 通过真实 RPC 验证完整用户流程，保留记录。
- 补充安装与使用说明，串行执行 Standards / Spec review 并修复问题。

## 验证记录

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
