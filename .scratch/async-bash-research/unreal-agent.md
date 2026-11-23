# Unreal Agent：工具结果可以不是最终结果

commit `a5f3fd1`，2026-10-06。`harness/tool/bash/`、`harness/operation/shell.go`、`harness/coordinator/loop.go`。README 自称 async-first agent harness。

## 1. 形态

它没有后台开关，也没有轮询工具。异步写在协议层：**一次工具调用的结果允许先返回「还在跑」，真实结果稍后补上**。

```go
type CallStatus struct{ WaitingFor []operation.ID }
```

翻译器把工具调用变成 operation，工具调用状态只记「在等哪些 operation」。结果何时成形由 operation 决定。`harness/tool/tool.go:12-20`

## 2. 怎么启动

工具只有一个 `Bash`，参数两个。`harness/tool/static.go:54-66`

```text
Execute a shell command in background. Independent commands may be issued as parallel tool calls in one turn. Command child processes are killed when the shell exits.
```

- `command` 必填。
- `max_output_length` 默认 40000 字符，上限 1000000。`harness/operation/output.go:7-10`

没有 `timeout`，没有 `background`，没有会话编号。

## 3. 启动返回什么

先落一条 Running 状态的结果。`harness/contextbuilder/builder.go:15-16`

```text
Tool call is still running. Its result arrives in a later turn: continue with independent work, or end your turn to wait for it.
```

`builder.go:127-145` 会把任何 Running 结果统一换成这句话，所以真正的内容不会提前泄露。

## 4. 怎么再读输出

模型没有读工具，也没有按 ID 查状态的工具。它只有两条路。

- 等真实结果在新的一轮里回来。
- 发一条新的用户输入，或者等心跳。

输出同时写文件，`out` 与 `err` 放在会话目录里，结果里带路径。`shell.go:20-23`

## 5. 完成怎样被感知

operation 变终态后，`reconcileToolCalls` 把调用状态写入会话，`finishToolCall` 把可用输入数加一，协调器据此再调一次模型。`coordinator/loop.go:722`、`coordinator/loop.go:863-899`

新的一轮里，模型看到的还是同一个呼叫编号，内容换成了真实结果。`builder.go:121-140`

## 6. 模型怎样被唤醒

不用唤醒，因为没有「结束本轮」这个动作。协调器一直等着，直到所有 operation 终结或者用户叫停。`coordinator/loop.go:215`、`coordinator/loop.go:326-328`

等太久时它自己发心跳，把还在跑的工具调用列出来。TUI 默认 10 分钟一次。`coordinator/loop.go:288-305`、`cmd/unreal-agent-tui/run.go:262`

```text
Heartbeat: waited %g seconds for tool calls.
Running: [...]
```

心跳是一条控制输入，会触发一次模型调用，模型因此有机会决定继续干活还是干等。

## 7. 并发与隔离

- 一轮里可以并发多个 Bash 调用，每个调用各自一份 operation。`static.go:55`
- 每个 operation 有独立的 phase 机：建目录、建 out、建 err、起进程、读 out、读 err、读尾部。`shell.go:24-36`
- phase 和进程组 ID 都落进 operation 状态，崩溃后可以接着推。`shell.go:200-215`
- 进程组号就是 shell 的 PID，杀死按进程组。`shell.go:318`、`primitives/process.go:253`

## 8. 超时与取消

- 没有超时。Bash 没有这个参数，operation 里也没有 deadline。
- 模型侧没有 kill 工具。
- 只有用户侧停止能取消 operation，`StopHard` 与 `StopWhenIdle` 两种。`coordinator/loop.go:419-433`

所以一条永不结束的命令会一直占着这一轮，只靠心跳反复告诉模型「它还在跑」。

## 9. 输出预算

- 默认 40000 字符，头尾各取一半，中间插一行说明带完整输出路径。`operation/output.go:22-38`

```text
...%d bytes truncated; complete output in <path>...
```

- 上限 1000000 字符，超过直接拒绝参数。`tool/output.go:31-32`

## 10. 边界与已知坑

- 结果晚到是常态，模型必须能接受「先拿到占位结果，稍后拿真实结果」。
- 心跳间隔决定模型多久被提醒一次，间隔越长越接近静默。
- 命令退出后它启动的子进程被杀，描述里写明了这一点。
- 崩溃恢复依赖 operation 的 phase，恢复时如果进程启动没记录，会直接失败而不是猜。`shell.go:200-207`
- 一次工具调用只允许一个 operation，多个会报错。`bash.go:96-105`

## 11. 已知空白

- 没有考察远端 operation（`remote_job.go`）与本地 shell 的差别。
- 没有实机验证心跳到点后模型实际会做什么。
- 没有考察 UI 侧如何展示 Running 结果与后续替换。
