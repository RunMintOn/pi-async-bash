# Async Bash for Pi

构建和测试可以留在后台继续跑。短命令直接返回。长命令完成后，Pi 把结果送回原会话。

## 本地使用

用 Pi 1.6.0 加载当前工作区的扩展。

```bash
npm ci
pi -e ./index.ts
```

## 工具

```typescript
bash({ command: "npm test", timeout: 120 })
```

`timeout` 沿用原生 Bash 的执行超时，单位为秒。省略时命令没有执行超时。30 秒内结束，直接拿到原生 Bash 的结果。仍在运行时，收到 `status: "running"`、`task_id` 和 `log_path`。原进程继续，执行超时也继续计时。

```typescript
bash_task({ task_id: "...", wait_seconds: 5 })
bash_task({ task_id: "...", wait_seconds: 0 })
```

`bash_task` 默认最多等 30 秒，允许 0–300 秒。传 `0` 立即查看。命令提前结束时立即返回最终结果。等待到期或取消等待，原命令继续。

每次查看返回状态和日志末尾，最多 40 行、4 KiB。`start_line` 和 `end_line` 对应完整日志的 1 起始行号。用 `read` 的 `offset` 可以定位更早的内容。如果最后一行单独超过字节上限，预览会标明只显示了这一行的末尾。

## 接续与停止

- 任务完成时，Pi 唤醒空闲的原会话。原会话正在工作时，结果会随下一次模型调用送达。切走期间完成的结果，切回原会话时送达。
- 模型直接调用 `bash_task` 拿到最终结果时，Pi 省去自动通知。通过 codemode 在脚本内读取时，Pi 仍会通知原会话。以后可以用同一个 ID 复查。
- 用 `/bash-stop <task_id>` 停止已交接的命令。取消还未交接的 `bash` 则会停止该次命令。
- 完整日志在当前 Pi 进程内保留。完成预览按需从日志生成。正常退出时，扩展停止受管任务并清理交接日志。TUI 底部状态栏显示当前会话的后台任务。
- Fork 会继承历史中的工具消息。任务查询、停止和完成通知仍归启动命令的会话。

## 开发

```bash
npm run check
npm test
```

测试使用 Pi 1.6.0、真实 Shell 和离线模型。RPC 测试保留事件记录，缓存回归保留 OpenAI 适配器生成的请求。测试输出会打印临时目录。

- 改工具契约时读 [SPEC.md](SPEC.md)。改完成投递、提示词或日志时，先读 [T11 的维护要点](.scratch/bash-task-handoff/issues/01-bash-task-handoff.md#维护要点)。
- 改工具描述、`promptSnippet` 或 `promptGuidelines` 时读 [模型可见提示词的设计规则](PROMPT_DESIGN.md)，其中记录了分层、已固定措辞的理由和被否掉的同步阻塞方案。
- 调整交接或等待时长时，读[阈值样本与统计口径](THRESHOLD_ANALYSIS.md)。比较其他 Agent 的执行与提示设计时，读[异步 Shell 调研索引](.scratch/async-bash-research/README.md)。
- [TICKETS.md](TICKETS.md) 记录历史实现与验收。

## License

MIT
