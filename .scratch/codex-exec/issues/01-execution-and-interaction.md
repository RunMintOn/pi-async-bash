# Codex 式执行与交互

状态：已完成

范围与验收依据：SPEC.md。

本功能需要统一改变执行、工具结果与生命周期，拆成多个独立任务会产生不一致的中间契约，因此只保留一个任务，内部串行完成纵向切片。

## 顺序

1. 已完成：真实会话验证分段等待和增量输出，再实现最小管道路径。
2. 已完成：验证 stdin 与真实 PTY 交互，再实现终端和明确停止。
3. 已完成：验证取消、会话归属、reload、Footer 与输出边界，移除旧通知机制与过期测试。
4. 已完成：真实 CLI/RPC 验证，类型检查和完整回归，自行 review 后更新使用文档与本记录。

## 验证记录

- 红灯：原实现无法返回新进程引用，`/tmp/async-bash-codex-red.log`。PTY 切片先失败，之后确认 node-pty 的 Unix 预编译 helper 缺少可执行权限；安装期修正后通过。
- 最终目标版本：仓库开发依赖固定 Pi 1.4.0；Node 22.23.2，macOS。早期沿用的 1.3.0 测试依赖已更新，不改全局 Pi。
- `npm run check` 通过：`/tmp/async-bash-codex-check.log`。
- `npm test` 23/23 通过，约 34 秒：`/tmp/async-bash-codex-final.log`。包括真实默认十秒交接、独立工具并行、真实 PTY/Ctrl+C、取消、增量 UTF-8 输出、会话与 fork、CLI/RPC、退出及 SIGTERM 清理。
- 最后收紧引用来源后，受影响生命周期、Footer 与 RPC 回归 8/8 通过：`/tmp/async-bash-codex-reviewed.log`。
- 最终 RPC 记录：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-CL2pMr`；信号清理记录：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-rpc-wPgRnf`。
- 离线 provider HTTP 前缀记录：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-test-y2SUP5/prefix-requests.json`。不测量真实服务端缓存命中率。
- 打包并在独立目录安装，PTY 返回 `PACKAGE_PTY_OK`：`/tmp/pi-async-bash-package-HTIcK9`。确认安装 hook 和发布文件清单，不执行发布。
- 串行自行 review：检查接口与 Spec、取消/退出、会话归属、输出上限及包安装。修正重复会话引用记录、预览异常可能逃逸、结束后保留进程对象和引用识别过宽的问题。类型与受影响回归通过；`git diff --check` 通过。
- 仅使用本地确定性 provider；没有付费模型调用、子代理、加载配置变更、commit、push 或发布。Linux 未实测，Windows 不支持。原有未跟踪的 `ARCHITECTURE.md` 未修改。

## 本对话 review 后修复

- 修复 Shell 退出后同组子进程脱离清理：管道与 PTY 在主命令退出时立即清理剩余进程组，保留主命令的原退出码，不保存过期组 ID 用于后续停止。
- 修复 stdin 背压绕过等待窗口：写入与完成/窗口到期竞争，超时后仍保留原有流写入顺序，不等待程序消费全部输入才返回。
- 先补真实 AgentSession 回归，再修改实现。管道和 PTY 子进程清理测试均先失败：`/tmp/async-bash-group-red.log`；背压测试先因超过窗口失败：`/tmp/async-bash-input-red.log`。
- 修复后生命周期测试 7/7 通过：`/tmp/async-bash-group-green.log`；背压及跨窗口输入顺序测试通过：`/tmp/async-bash-input-green.log`。
- 最后将子进程检查提前至会话销毁前，确认清理发生在 Shell 退出时；重跑两种模式 2/2 通过：`/tmp/async-bash-group-final.log`。
- 完整测试 26/26 通过，约 35.5 秒：`/tmp/async-bash-fix-full.log`；类型检查通过：`/tmp/async-bash-fix-check.log`；`git diff --check` 通过。README 与 Spec 已补充主命令退出时清理、背压和输入排队语义。
- 串行复查了退出码保留、清理时机、写入顺序、窗口到期后的异步错误处理及取消路径；没有派发子代理、提交、发布或修改加载配置。

## 模型接口说明

- 按用户要求，以本地 Codex 源码 `c22a06c1` 的 `codex-rs/core/src/tools/handlers/shell_spec.rs` 为底稿修改 `index.ts`：保留工具用途的简短措辞，将等待默认值和范围放入各自的参数说明。
- 只适配当前契约：`exec_command`/`cmd` 改为 `bash`/`command`，默认管道、可选 PTY；说明返回引用用于接续、空输入轮询和当前取消语义。没有复制不存在的参数，也没有新增 sleep、轮询或 shell timeout 禁令。
- 类型检查、差异空白检查和工具回归 6/6 通过：`/tmp/async-bash-descriptions-check.log`、`/tmp/async-bash-descriptions-tools.log`。只改说明，没有更改执行逻辑或等待范围；没有运行真实模型行为实验。
