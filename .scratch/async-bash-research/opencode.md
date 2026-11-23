# OpenCode：Shell 工具 + Job 状态机

commit `843a6c514e`（v2.0.32）。工具 `packages/core/src/tool/plugin/shell.ts`，进程 `packages/core/src/shell.ts`，作业 `packages/core/src/job.ts`。

## 1. 形态

前台调用本身就是一个 job。job 可以在运行中被「挪到后台」，也可以从一开始就用 `background: true`。完成时投递一条合成消息，并自动唤醒会话。

```
shell(background?) ─▶ Job.start ─▶ block() ─┬─ finished ─▶ 工具结果
                                            ├─ backgrounded ─▶ "moved to the background" + 完成通知
                                            └─ background:true ─▶ 立即返回 shellID + 完成通知
```

## 2. 怎么启动

`schema` 四个可选参数，`background` 是新增的那个。`tool/plugin/shell.ts:52-63`

```ts
background: Schema.optionalKey(Schema.Boolean).annotate({
  description:
    "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
})
```

工具描述把三条规则写在一起。`tool/plugin/shell.ts:36-46`

```text
Commands accept an optional timeout, background commands have no timeout by default.
Background commands return immediately, and you will be notified when they complete.
```

超时语义分两条路径：前台默认 120 s，后台默认 0（不超时）；运行中被转后台时，会把剩余超时清成 0。`tool/plugin/shell.ts:201`、`tool/plugin/shell.ts:262`

## 3. 启动返回什么

前台：命令结束才返回，输出里带 `exit`/`signal`/`timeout`/`truncated`，没有 shellID。

后台：立即返回一行固定文案，带 shellID 和输出文件路径。`tool/plugin/shell.ts:96-100`

```text
Command moved to the background (shell ID: ${shellID}).
Output is streaming to: ${file}
```

结构化字段只给 `shellID`、`truncated: false`、`status: "running"`。

## 4. 怎么再读输出

模型没有「按 ID 读输出」的工具。工具返回值里说明输出在文件里，但它不鼓励模型去读。

轮询被明确禁止，用的是一段固定指令，后台路径的返回值会附上它。`tool/plugin/shell.ts:26-27`、`tool/plugin/shell.ts:96-100`

```text
You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.
```

## 5. 完成怎样被感知

`notifyWhenDone` 等 job 落定，取整段结果，投一条合成消息。`tool/plugin/shell.ts:157-186`

消息体是 XML 片段，`state` 三态，带退出码或信号。`packages/core/src/shell/result.ts:45-63`

```xml
<shell id="${jobID ?? shellID}" state="completed|cancelled|error" command="${command}">
${text}
</shell>
```

## 6. 模型怎样被唤醒

合成消息走 `Session.synthetic`，默认投递方式是 `steer`，成功后调 `execution.wake(sessionID)`。空闲会话因此自己开下一轮。`packages/core/src/session/session.ts:273-310`

`resume: false` 可以只落记录不唤醒。重启恢复的通知就用这个，避免唤醒只是挂着长命令的空闲会话。`packages/core/src/session/execution/restart.ts:123-135`

另有一条完全不同来源的自动唤醒：用户主动把阻塞工作转后台时，会话收到一条说明。`packages/core/src/session.ts:444-461`

```text
User requested that active blocking work be moved to the background.

Backgrounded work:
- ...

The backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation.
```

## 7. 并发与隔离

- 一个 job 一个 scope，`Job.start` 不抢占同名运行中的 job，直接复用。`job.ts:257-296`
- 多个会话可以同时 block 同一个 job，`blockingSessions` 计数。`job.ts:322-353`
- 只有仍在阻塞某会话的 job 才会被 `backgroundAll` 选中。`job.ts:387-410`
- 已消费的完成记录保留 25 条，超出按首次消费顺序淘汰。`job.ts:36`、`job.ts:186-196`
- Shell 侧：内存里保留最近 25 个已退出进程，输出文件保留 7 天。`shell.ts:32-33`
- 进程用 `detached` 启动，`stdin: "ignore"`，`forceKillAfter: 3s`。`shell.ts:305-309`
- Shell 启动前的目录与权限检查在 `prepare`，审批可以晚于目录存在性检查，所以在 spawn 前再验一次。`tool/plugin/shell.ts:139-166`

## 8. 超时与取消

- 超时是独立 fiber，到点 `finish("timeout")`，同时 `handle.kill({ forceKillAfter: 3s })`。`shell.ts:379-405`
- `shell.timeout(id, 0)` 清空超时，用于「转后台后不再限时」。`shell.ts:191-196`
- 终态先解析等待者，再处理保留淘汰，避免被淘汰的进程报 `NotFoundError`。`shell.ts:359-376`
- 取消 job 走 `Scope.close`，会中断运行 fiber。`job.ts:412-439`
- `SIGTERM` 被忽略时靠 `forceKillAfter` 升级到强制杀，测试覆盖。`packages/core/test/tool-shell.test.ts:1732-1763`

## 9. 输出预算

- 输出写文件，按字节游标读，默认一页 64 KiB。`shell.ts:198-227`
- 结果只取尾部，行数与字节双上限，超出加一行提示带总行数与文件路径。`shell.ts:228-252`

```text
[showing lines ${total - shown + 1}-${total} of ${total}; full output saved to ${info.file}]
```

- 文件不存在时给固定的「输出已不可用」文案，不伪造空输出。`shell/result.ts:14-20`

## 10. 重启恢复

后台工作带一条可恢复记录：`recovery.kind === "shell"` 记住 sessionID、shellID、command，`notificationID` 一起落到 KV。`job.ts:198-210`、`job.ts:9-30`

启动时扫 `job.background/` 前缀：

- 进程还能接管：重新等，完成后再通知。
- 进程已不存在：投一条「因服务器重启而取消」的通知，`resume: false`。`session/execution/restart.ts:100-137`
- 通知投递成功即删除持久标记。`job.ts:452-462`

## 11. 边界与已知坑

- 后台默认没有超时，跑飞的命令只能靠用户取消。
- 只有 `background: true` 或中转后台的 job 才有完成通知；普通前台调用结束就结束。
- 通知是合成 user 消息，会进入模型上下文；`resume: false` 的通知只进记录。
- 后台 shell 输出只在文件里，模型拿到的通知文本是尾部截断版本。
- 前后台共用同一套 Job，subagent 也复用，`backgroundAll` 会一起处理。
- 输出文件 7 天清理，超过窗口的 shellID 只能拿到「输出已不可用」。

## 12. 已知空白

- 没有考察 TUI 如何绑定「转后台」这个动作。
- 没有验证通知与用户输入的先后顺序在真实使用中的表现。
- 没有考察多客户端同时连接时 `notificationID` 的去重边界。
