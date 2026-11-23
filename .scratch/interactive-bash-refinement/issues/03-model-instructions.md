# 03: 让模型实际收到完整且简洁的工具说明

**What to build:** 模型在工具 Schema 与系统提示词中收到适配后的 Codex 执行、接续和等待说明，同时保留 Pi 原生适用的环境指引。

**Blocked by:** 01: 收紧命令输入并恢复可编程输出。

**Status:** completed

- [x] 完成 Codex 原文、版本、适用对象、取舍与最终提示词位置的逐条对应表。
- [x] 两个工具均有准确 Snippet；Schema、字段 description 和 Guidelines 分工清楚，避免重复。
- [x] 保留适用的 Pi 环境说明；加入避免单次阻塞 sleep/wait 超过 60 秒的建议，不改变 300 秒能力上限。
- [x] 准确说明原进程引用、空输入等待、提前完成、到期不停止、取消差异及没有自动完成通知。
- [x] 不复制代码单元专属字段，不增加 sleep、轮询或 Shell timeout 的一概禁令。
- [x] 通过真实 AgentSession 检查最终模型上下文并保存可检查的原生/插件 Schema、Snippet、Guidelines 对比。
