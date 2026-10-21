# sleep 轮询调查

调查日期：2026-10-21。首次调查范围为已有会话、任务记录、测试日志和当前源码，当时未修改运行配置或实现，也未重跑 E2E 或通知链路测试。用户随后授权实施，结果见下一节。当前环境没有可用的子代理工具，本次直接完成调查与实施。

## 后续实施：通知延迟已复现

本节记录初次调查之后的发现和修改，后文保留当时的观察。

### 新证据

再次读取原始会话后发现，完成消息随后陆续进入了会话。任务 `f8633cc6` 的 `finished_at` 为 04:45:03.194 UTC，通知条目的写入时间为 06:28:57.107 UTC，间隔约 104 分钟。因此，初次检查时“没有找到通知”不能解释成“从未发送”；已观察到至少一条通知长时间排队后才被消费。

当前入口将通知设为 `deliverAs: "followUp"`。Pi 1.3.0 的 `pi-agent-core/dist/agent-loop.js` 在工具循环停止后才执行 `getFollowUpMessages()`；工具循环每轮结束则读取 `getSteeringMessages()`。`pi-coding-agent/dist/core/agent-session.js` 的 `sendCustomMessage()` 根据 deliverAs 把忙碌时的消息放入对应队列。

### 实施证据

- 新增 `test/busy-notification.test.mjs`：真实 AgentSession、真实子进程和受控交接时间。独立工具先释放后台任务，并等到任务终态保存后返回；本地确定性 provider 继续发出后续工具调用。测试断言该工具返回后的模型请求已经看到了正确任务的完成结果，不允许等整个循环停止后才送达。
- 修改前命令 `node --test test/busy-notification.test.mjs` 失败，错误为 `completion was withheld until the agent stopped its tool loop`。日志：`/tmp/async-bash-busy-red.log`。
- 将通知改为 `steer`，保留 triggerTurn、会话归属和去重。在工具批次完成后的边界进入上下文，不打断正在执行的工具。
- Bash 描述增加启动前指引：需要结果的任务直接执行实际命令，由工具负责后台交接，不用末尾的 & 自行后台化，也不创建 sleep 轮询来等待。后续 review 修正了最初单独提及 nohup 的措辞；单独使用 nohup 并不会使 shell 提前返回。没有禁止用户明确需要的独立后台服务，也没有增加 shell 拦截器。
- `README.md` 和 `SPEC.md` 同步，63 秒阈值和 bash_task 接口不变。

### 已验证的实际结果

- 修改前已有空闲通知测试通过：真实 65 秒命令以退出码 9 结束，通知自动恢复会话。日志：`/tmp/async-bash-lifecycle-baseline.log`。这证明旧实现并非完全不能通知。
- 新增忙碌场景修改后通过：完成结果在第一个独立工具结束后就进入下一次模型请求，独立工具链继续完成 STEP_4，通知只有一次。最近一次结果显示通知时间戳比任务结束晚 18ms。这是隔离场景的测量，不代表所有环境的延迟承诺。
- 日志：`/tmp/async-bash-busy-green.log`、`/tmp/async-bash-busy-final.log`。类型检查通过：`/tmp/async-bash-check.log`。
- 原会话同款真实模型 `magpie/workbuddy-ai/deepseek-v4.1-flash` 抽查通过：只发一次普通用户请求；fixture 前台运行一次，没有 nohup、sleep 或状态轮询；完成通知 3ms 后进入会话，模型自动继续并正确报告 fixture 退出码 7 与 `E2E_SENTINEL_DONE`。脚本实际运行 66 秒。可检查 prompt、events、summary、session：`/var/folders/zh/qf_nccyd0_b0fc84rk8dl4lm0000gp/T/pi-async-model-wait-65icBM`。
- 完整回归 16/16 通过，约 264 秒，包含真实 63 秒、RPC 和生命周期；日志 `/tmp/async-bash-regression.log`。完整回归启动后加强的忙碌测试另行重跑通过，日志 `/tmp/async-bash-busy-final.log`。详细结果见 `TICKETS.md` 的 T7。单次真实模型抽查不证明所有模型和长会话今后一定不会轮询。

## 结论

1. Agent 用 `nohup node scripts/e2e-flows.mjs > /tmp/flows-211*.log 2>&1 &` 自行启动后台测试，然后执行多条 `sleep; tail`。工具管理的后台任务是日志观察命令，测试本身没有交给自动后台机制管理。[S1]
2. 每次长 sleep 在 63 秒时交接后，Agent 又启动新的 sleep。旧命令继续运行，多条观察命令重叠。这不是测试需要的等待策略，也不能把所有 sleep 参数相加作为墙钟耗时。[S1][S2][S4]
3. 211f—211p 共 11 轮，包含 42 次 `sleep; tail`，其中 31 次交接后台。每次交接结果都明确说明不要轮询、无其他工作时结束轮次并等待通知。该区间没有 `bash_task` 调用。[S1]
4. 该区间的 31 个后台观察任务已有持久终态，但会话中没有对应的 `async-bash-completion` 条目。同一会话此前共有 67 条这类完成消息，最后一条时间为 2026-10-21 04:11:04.386 UTC。这说明此区间未见通知进入会话记录；不能仅凭当前源码确定当时未投递的原因。[S1][S2]

## 延迟证据

以下时间均为 UTC。延迟计算为最终前台 tail 的 toolResult 时间减测试日志 mtime。

| 轮次 | 测试日志最终写入 | 最终前台 tail 返回 | 结果读取延迟 |
|---|---|---|---:|
| f | 05:29:29.704 | 05:31:33.254 | 123.5 秒 |
| g | 05:33:01.944 | 05:35:02.961 | 121.0 秒 |
| h | 05:36:31.308 | 05:39:25.049 | 173.7 秒 |
| i | 05:40:57.055 | 05:44:07.650 | 190.6 秒 |
| j | 05:45:38.530 | 05:48:49.104 | 190.6 秒 |
| k | 05:50:16.385 | 05:53:27.971 | 191.6 秒 |
| l | 05:54:56.262 | 05:58:06.306 | 190.0 秒 |
| m | 05:59:34.281 | 06:02:46.619 | 192.3 秒 |
| n | 06:04:18.497 | 06:07:28.808 | 190.3 秒 |
| o | 06:09:01.749 | 06:12:13.331 | 191.6 秒 |
| p | 06:13:48.655 | 06:17:00.878 | 192.2 秒 |

合计约 1947.6 秒，即 32.5 分钟。各日志均以 FAIL 和 Artifacts kept 结束。当前测试脚本在这两行之后执行 `process.exit(1)`；日志写入时已经有足够的失败信息供诊断。mtime 不能精确证明历史进程的退出时间，所以该数字是“最终失败日志可读到 Agent 读取”的延迟估计，不是精确进程运行时间或已验证的优化收益。[S1][S3][S5]

以 n 为例：

```mermaid
sequenceDiagram
    participant A as Agent
    participant B as Bash 工具
    participant T as 自行后台的测试
    A->>T: 06:02:57 启动测试
    A->>B: 06:03:03 sleep 215; tail
    B-->>A: 06:04:06 交接，任务 e0c6758e
    A->>B: 06:04:13 sleep 100; tail
    T->>T: 06:04:18 最终失败日志写入
    B->>B: 06:05:53 第二个观察命令结束，日志含 FAIL
    A->>B: 继续启动 sleep 95 和 sleep 60
    B-->>A: 06:07:28 前台 tail 返回失败日志
```

`e0c6758e` 的 215 秒实际从 06:03:03 运行到 06:06:38。63 秒交接没有重启、取消或缩短 sleep。第二个观察任务 `f2814a78` 的已保存日志包含最终 FAIL，但未见相应完成消息写入会话。[S1][S2]

## 工具实际契约

- `bash` 在 63 秒后释放工具调用，原命令继续运行。`timeout` 限制整个命令的执行时间，交接不重置它。[S4]
- `bash_task` 只有 `status` 和 `kill`。`status` 用于按需诊断，不应通过反复调用它替代 sleep 轮询。[S4][S6]
- 当前通知实现订阅任务结束事件，按 owner session 过滤，在空闲或 turn/settle 边界通过 `sendMessage(..., {triggerTurn: true, deliverAs: "followUp"})` 请求继续。[S6]
- 任务终态持久化和完成通知投递是两个环节。终态 JSON 存在不等于通知已经进入会话。[S4][S6]

## 优化顺序

1. **让工具直接管理测试。** 执行 `node scripts/e2e-flows.mjs`，保留合适的执行超时，不自行添加 `nohup`、`&` 和 sleep 观察命令。需要保留独立日志时可重定向输出，但应让 shell 等待实际测试结束。
2. **交接后不再制造等待任务。** 有独立工作就继续；没有就结束轮次，由完成通知恢复。需要诊断进度时按需调用 `bash_task status`。
3. **确认通知链路。** 用一个受控长命令验证：63 秒交接后 Agent 结束轮次，命令结束后原会话收到结果并自动继续。还应覆盖 Agent 正在执行另一工具时任务结束的情况。当前调查尚未执行该验证，不能宣称通知机制正常，也不能确定需要修改哪个模块。
4. **缩短调试反馈。** 11 轮均重跑同一个大型 E2E，并在缩放/拖动附近失败。可评估提取可独立运行的失败场景，先读取实际页面状态再修改，最后跑完整流程。尚未验证当前脚本支持哪些隔离运行方式。[S1][S3][S5]

本次证据不支持优先调整 63 秒阈值。首先应纠正任务启动方式，并查清未见完成通知的原因。单纯更换等待工具或缩短 sleep 仍会保留轮询策略。

## 来源

- **S1 原始会话**：`/Users/ziqian/.pi/agent/sessions/--Users-ziqian-20-dev-10-projects-v02-paper--/2026-10-03T15-12-30-551Z_01a10252-e957-7197-bc88-e956ad883a56.jsonl`。零基条目 18006—18142 覆盖 f—p；18104—18116 为 n；18130—18142 为 p。计数按实际 toolCall/toolResult 和 custom_message 解析。
- **S2 任务元数据与输出**：`/Users/ziqian/.pi/agent/extension-data/async-bash/`。示例：`e0c6758e.json`、`f2814a78.json`、`f2814a78.log`。按 S1 中 toolResult.details.task_id 关联，读取 finished_at。
- **S3 测试日志**：`/tmp/flows-211f.log` 至 `/tmp/flows-211p.log`。读取完整日志尾部和文件 stat 的 st_mtime。
- **S4 当前任务管理实现**：`src/tasks.ts`，`TaskManager.execute`、`settle`、`control`、`describe`。
- **S5 当前测试实现**：`/Users/ziqian/20-dev/10-projects/v02-paper/scripts/e2e-flows.mjs`，末尾 try/catch。其他 Agent 仍可能修改该工作区，不能把当前文件当作所有历史轮次的精确快照。
- **S6 当前扩展入口**：`index.ts`，工具注册、session_start、flush、任务订阅及 context handler；使用说明见 `README.md`。源码代表磁盘当前状态，未检查历史 Pi 进程实际加载的模块实例。
