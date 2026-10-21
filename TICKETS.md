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

### T8 — 后台状态快照保留历史缓存前缀

- 状态：已完成。本地 ticket 位于 `.scratch/cache-prefix/issues/01-preserve-task-history-prefix.md`；不创建真实 API 对照 ticket，由用户日常使用观察。
- 将请求时的临时任务状态快照从历史之前移到请求尾部。历史消息及顺序不变，状态变化只影响先前的尾部快照和后续新增内容；任务筛选、16 KiB 恢复预算及通知机制不变。
- 新增真实 provider 适配器的请求前缀回归，fetch 在本地拦截，不连接模型服务。旧实现先失败，修改后通过；保留请求体供检查。另一场景实际压缩掉原始任务结果，再验证运行中恢复、任务在其他会话期间完成后的终态恢复，以及历史前缀稳定和不重复自动通知。
- 本地确定性 provider 从最后一条非状态快照消息识别测试指令，使尾部快照不遮挡脚本化工具调用；捕获和前缀比较仍使用完整请求。
- 完整 `npm test`：18/18 通过，约 266 秒，包含真实 63 秒交接、空闲和忙碌通知、RPC、fork、reload、崩溃恢复及 compact 兼容。日志：`/tmp/async-bash-cache-full.log`。红灯：`/tmp/async-bash-cache-red.log`；类型检查：`/tmp/async-bash-cache-check.log`；`git diff --check` 通过。
- 请求体：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-test-1FQdb0/prefix-requests.json`；恢复请求体：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-test-KHKzMS/restored-prefix-requests.json`；RPC：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-Z4rWG6`。
- 未调用真实模型 API，未修改全局配置或自动重载用户其他会话。用户随后授权提交并 push，但不发布 npm 包或 Release；README Beta 已说明尾部快照仍可能影响最近上下文的缓存复用，更好的机制仍在探索。已有未跟踪的 `ARCHITECTURE.md` 未改动且不纳入提交。已加载旧扩展的会话需 `/reload` 或重启 Pi 才能使用修复。

### T7 — 活跃工具循环中的完成通知与等待行为

- 状态：已完成。通知修复、快速验证、完整回归与真实模型行为抽查均通过。
- 原始会话证实旧任务完成通知长时间延迟进入对话。隔离复现证实 `followUp` 要等 Agent 停止工具循环；改用 `steer` 后，完成结果在当前工具批次结束后的模型请求中可见。
- 新增忙碌通知回归，修改前失败，修改后通过；独立工作继续执行，正确任务通知恰好一次。最近一次记录为任务结束后 18ms 进入会话。63 秒使用受控时间，进程与会话为真实实现；没有通过 mock 消息队列证明自身。
- 空闲通知基线等待真实 65 秒通过。日志：`/tmp/async-bash-lifecycle-baseline.log`。忙碌通知：`/tmp/async-bash-busy-red.log`、`/tmp/async-bash-busy-final.log`。类型检查：`/tmp/async-bash-check.log`。
- 前台运行指引放入 Bash 工具描述，让 Agent 在首次执行前知道已有交接机制。接口、63 秒和 timeout 不变，没有全面阻止 `&` 或合法 readiness 检查。
- 新增可选 `probes/model-wait.mjs`，只发一条普通用户请求，运行真实 66 秒 fixture，观察是否自行后台化或轮询、完成通知是否触发后续回答、退出码与结果是否正确。此探针使用现有凭据调用真实模型，不纳入默认 npm test。
- 真实模型 `magpie/workbuddy-ai/deepseek-v4.1-flash` 抽查通过：一次用户请求，fixture 启动一次，模型先检查脚本后前台运行，无 nohup、sleep、日志或状态轮询；完成通知一次，任务结束后 3ms 进入会话，模型自动继续并正确报告 fixture 退出码 7 和 `E2E_SENTINEL_DONE`。模型使用 `node fixture.mjs; echo "EXIT_CODE=$?"`，外层 shell 的退出码为 0；最终回答正确区分了两个退出码。未增加第二条用户提示。
- 真实模型探针日志：`/tmp/async-bash-live-model.log`；完整 prompt、events、summary、session 保存在 `/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-model-wait-65icBM`。这是一项隔离抽查，不证明所有模型和长会话今后均不会轮询。
- 完整 `npm test`：16/16 通过，约 264 秒，包含真实 63 秒交接、空闲通知自动接续、RPC 生命周期、reload、会话归属、超时、取消和 compact 兼容。日志：`/tmp/async-bash-regression.log`。完整回归启动后，忙碌场景测试又加强了“通知到达后独立链仍完成 STEP_4”的断言，该最终版本已单独重跑通过：`/tmp/async-bash-busy-final.log`。
- RPC 记录：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-AVPa3I`；崩溃恢复记录：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-YEpF6g`。类型检查、`git diff --check`、真实模型探针语法检查均通过。
- 未修改用户全局配置，未自动 reload 用户正在运行的会话，未发布或 push。现有 `ARCHITECTURE.md` 为用户已有未跟踪文件，未改动且不纳入本次提交。
- 当前配置从本地目录加载此扩展；已运行的会话需要执行 `/reload` 或重新启动 Pi 才会使用新的工具描述和投递代码。本次未对用户正在执行任务的其他会话强制重载。
- 后续 review 按用户确认修正工具说明：只针对末尾 `&` 导致启动命令提前返回及另建 sleep 轮询，不单独禁止 `nohup`。保留原有交接与自动通知说明。此前真实模型抽查针对修正前的说明，不能视为最终措辞的行为验证；已形成等待习惯的长会话尚未验证。用户授权本次提交，不 push。
- 最终措辞修改后，类型检查通过；忙碌通知及 compact 两种加载顺序 3/3 通过；探针语法及差异空白检查通过。日志：`/tmp/async-bash-final-wording-check.log`、`/tmp/async-bash-final-wording-tests.log`。未重跑完整套件或额外调用真实模型。

### T6 — compact 兼容与后台 Footer

- 范围：两个本地 ticket 位于 `.scratch/bash-compat-footer/issues/`；串行实施，不创建远端 issue。
- compact 停止注册 bash，保留现有 TUI 展示链路和 edit/write 执行包装。三种紧凑风格用 `Backgrounded` 记录交接；模型结果不变，off 保留原始内容。
- async-bash 使用原生 `setStatus` 显示 `BG N · 时长 / 时长`，按实际启动顺序每秒更新；终态即移除，无任务时停止计时。仅匹配当前 owner 或活动分支继承引用，排除前台及 unknown。
- 计时基于生命周期边界取得的快照，完成订阅负责移除任务。每秒不读磁盘或日志；没有改动管理器或执行规则，已有进程级管理器可继续使用。
- 回归测试先在重复注册处失败，再在工具行仅显示 `4 lines` 处失败；修复后两个顺序均通过短命令、加速 63 秒交接、三种风格、off 与完成通知接续。日志：`/tmp/pi-async-compat-red.log`、`/tmp/pi-async-compat-display-red.log`、`/tmp/pi-async-compat-green.log`。
- Footer 的三个真实会话场景已通过：并发数量/计时/结束/窄宽度、切会话/fork/reload/清理、codemode 内 bash。原生 FooterComponent 的 80/20 列输出保留在 `/tmp/pi-async-footer-nested.log`。这些新增场景使用可控时间、真实子进程，不调用外部模型 API。
- compact 自有测试新增外部 bash 执行与后台展示场景。完整 `npm test`：async-bash 15/15 通过，约 266 秒，包含真实 63 秒和真实 CLI/RPC；compact 当前工作树 `npm run check`：82/82 通过。两仓类型检查及 `git diff --check` 通过。
- 完整日志：`/tmp/pi-async-compat-footer-full.log`、`/tmp/pi-async-compat-footer-types.log`、`/tmp/pi-compact-compat-footer-full.log`。RPC 记录：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-5xGKjO`；崩溃恢复：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-fgM1n5`。
- compact 的提交 `ef33f0c` 按原 HEAD 仅加入本次四个文件的修复，不混入已有修改。独立导出的提交快照通过类型检查和 77/77 测试：`/tmp/pi-compact-isolated-full.log`。
- 串行 Standards review：检查 async 相对 `375dc41` 的差异，以及 compact 相对修改前快照的增量；保留用户已有展示改动，恢复一处不必要的列表编辑，无未解决问题。串行 Spec review：对照两个 ticket，加载顺序、执行归属、后台展示、原生 Footer、会话归属和生命周期均有对应实现与验证，无未解决问题。
- 验证包含真实组件渲染，但没有在用户日常全部扩展环境中启动交互式终端，也没有调用真实模型；没有修改全局配置或 Pi 安装文件，没有 push。
- review 后重跑受影响场景：async 5/5、compact 7/7 通过，日志为 `/tmp/pi-async-final-targeted.log`、`/tmp/pi-compact-final-targeted.log`。

### T5 — 明确完成通知的接续动作

- 状态：已完成。自动完成通知在原任务结果前增加：`Background bash task finished. Use the result below to continue any dependent work.`
- 交接返回删除重复介绍 status、kill 的一行；README 示例同步。普通 status、kill 结果保持不变，工具接口及 63 秒阈值不变。
- 真实 AgentSession 通知与自动接续测试通过，约 66 秒：`/tmp/pi-async-notice-tests.log`。类型检查通过：`/tmp/pi-async-notice-types.log`；`git diff --check` 通过。
- 本次只重跑受影响的通知场景，未重跑完整测试套件；未调用外部模型 API。检查差异后未发现额外行为改动。

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

## 发布

- 状态：已公开。GitHub `RunMintOn/pi-async-bash`（public，默认分支 `main`），npm `@runminton/pi-async-bash@0.1.0`，MIT。
- 包名：`pi-async-bash` 已被其他维护者占用，改用作用域 `@runminton/pi-async-bash`；GitHub 仓库名保持 `pi-async-bash`。
- 发布准备：删除 `private`；新增 `files`、`license`、`repository`、`keywords`；宿主提供的 `@earendil-works/pi-coding-agent` 与 `typebox` 按 Pi 包文档改为 `peerDependencies: "*"`；README 改为唯一英文版并新增 MIT `LICENSE`。
- 打包内容只有 `index.ts`、`src/status.ts`、`src/tasks.ts`、`README.md`、`LICENSE`、`package.json`，不含测试、分析材料与 `.scratch`。
- 首次发布后 registry 先出现 `0.0.0-stage` 占位版本，约数分钟后 `0.1.0` 生效；占位版本已标记 deprecated，指向 0.1.0。
- 直接下载 registry 上的 0.1.0 tarball 解包后，用真实 `DefaultResourceLoader` 加载，工具为 `bash`、`bash_task`，无扩展错误。
- 未在用户日常完整扩展环境启动交互式 TUI；未调用外部模型。GitHub 与 npm 均为用户明确授权的公开操作。
