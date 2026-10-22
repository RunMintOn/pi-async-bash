# 01: 收紧命令输入并恢复可编程输出

**What to build:** Agent 通过 command 中的 cd 切换目录；bash 和 write_stdin 均返回本次输出的截断状态、完整日志路径及单次交互耗时，直接调用和 codemode 取得一致数据。

**Blocked by:** None (can start immediately).

**Status:** completed

- [x] 删除并拒绝 workdir；cd 不改变 Pi 的 cwd，Shell 前缀仍适用。
- [x] 两个工具返回 output、truncated、wall_time_seconds，以及互斥的整数 exit_code/session_id。
- [x] 截断时提供指向整个命令日志的 full_output_path；本次未截断时省略，不继承历史截断状态。
- [x] 耗时表示本次 execute 的单调时钟耗时，包括排队和背压，不表示进程累计运行时间。
- [x] 真实 AgentSession 与 codemode 回归验证新契约，原有取消、输入顺序和增量读取保持有效。
- [x] 更新用户文档中的输入与结果说明。
