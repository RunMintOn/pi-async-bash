# pi-async-bash

让长时间运行的 bash 命令不再一直占住当前工具调用。

- 63 秒内结束：返回原来的 bash 结果。
- 超过 63 秒：返回 task ID，命令继续运行，结束后通知原会话。
- 新增 `bash_task`，提供 `status`、`kill`。
- 不增加 `background` 参数，不要求 Agent 预测命令耗时。

## 加载

在想工作的目录启动 pi，并指定此扩展的绝对路径：

```bash
pi -e /absolute/path/to/pi-async-bash/index.ts
```

没有自动修改你的 pi 配置。运行扩展使用 pi 提供的 TypeScript 加载器和依赖；开发、类型检查及测试才需要在此目录执行 `npm ci`。

已经加载旧版本时，请在任务结束后重新启动 pi，使新阈值生效；reload 会保留进程级任务管理器。

已验证 pi 1.3.0、Node 22.23.2、macOS。实现复用 pi 的本地 shell 后端；没有验证 Windows。

不要同时加载另一个覆盖 `bash` 的扩展。pi 1.3.0 对重复工具只报告冲突，按加载顺序选中定义，不会把两个执行后端自动组合起来。本扩展支持标准 `shellPath`、`shellCommandPrefix` 和 `tool_call` 限制，不承诺组合其他扩展私有的 spawn hook、SSH 或 sandbox 执行后端。

## 使用

普通 bash 参数不变：

```typescript
bash({ command: "npm run e2e", timeout: 600 })
```

63 秒未结束时，返回：

```text
Still running after 63 seconds. Task: <task_id>
Log: <absolute_log_path>
You will be notified when it finishes. Do not poll.
Continue work that does not depend on this result. If none remains, end your turn and resume when notified.
bash_task supports status and kill.
```

之后按需操作：

```typescript
bash_task({ task_id: "...", action: "status" })
bash_task({ task_id: "...", action: "kill" })
```

新任务 ID 为 8 位随机十六进制字符，例如 `a3f8c921`，重名时重新生成。已有 UUID 任务仍可查询和控制。

| 操作 | 行为 |
|---|---|
| status | 返回状态、日志位置和有界的日志尾部 |
| kill | 停止受管理的进程组，确认结果后返回；已结束任务保持原结果 |

`timeout` 是整个命令的执行上限，后台交接不会重新计时。63 秒是等待阈值，不是执行超时。

`bash_task` 不再支持 `wait`，`bash` 不增加同步等待参数。收到运行中结果后，继续处理不依赖该结果的工作；没有其他工作时，结束当前轮次，由完成通知继续任务。

## 生命周期

- 返回 task ID 前，Escape 取消当前命令。
- 返回 task ID 后，Escape 不会停止该任务；需要停止时使用 kill。
- `/tree`、切会话、fork/clone 和 reload 不停止任务。
- 完成通知只自动唤醒原 owner 会话。回到其他分支时补充状态，不重放自动通知。
- fork/clone 继承的是同一个 task ID，不复制进程；继承会话可以显式查询和停止它。
- 正常退出 pi 会停止当前进程管理的任务。
- 崩溃后不承诺任务存活或完整清理；新运行时把无法确认的旧执行标为 unknown，不猜退出码、不凭 PID 接管或停止。
- 持续运行的服务通常不会自然退出。task 为 running 不代表服务已经就绪。

自动交接只释放这一次 bash 调用。同一批次还有其他阻塞工具时，当前 turn 仍可能需要等待。

## 输出与状态

完整 stdout/stderr 保存为日志。任务元数据保存在 pi 的 agent 数据目录下的 `extension-data/async-bash/`；不会写入项目目录。普通短命令也会产生原始输出日志，但不会暴露 task ID 或建立后台完成通知。

完成通知和 status 的日志尾部最多 100 行、16KiB。恢复上下文有单独的 16KiB 总预算，不反复注入完整日志。

状态包括 running、exited、killed、timed_out、failed、unknown。非零退出属于 exited，退出码另行保留。status 查询失败任务本身不报工具错误；kill 返回失败终态时会标记错误。

codemode 中：

- 短 bash 返回原有 `output`、`exit_code` 等结构化字段。
- 长 bash 返回 `task_id`、`status: "running"`、`log_path` 等字段，退出码为 null。
- `bash_task` 返回任务状态和有界 `output`，脚本应检查状态与退出码。

没有历史日志自动清理、PTY、自动重试、任务列表或跨 pi 进程任务接管。终止保证限于受管理的普通进程组，不包括主动脱离该进程组的 daemon 后代。

## 开发与验证

```bash
npm ci
npm run check
npm test
```

测试使用本地确定性 provider、真实 AgentSession、真实 CLI/RPC 和真实子进程。不调用外部模型 API。测试包含多次真实 63 秒交接，通常约四到五分钟。

RPC 测试输出临时结果目录，保留各进程的 `events-<pid>.jsonl`、`stderr-<pid>.log`、会话和命令日志。

本地工作记录见 `TICKETS.md`，验收约定见 `SPEC.md`，研究证据见 `INVESTIGATION.md`。
