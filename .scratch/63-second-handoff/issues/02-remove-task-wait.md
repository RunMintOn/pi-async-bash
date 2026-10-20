# 02: 移除任务等待并明确后台接续指引

**What to build:** bash_task 仅保留 status、kill。任务交接后继续独立工作；没有其他工作时结束当前轮次，由完成通知恢复处理。保留 63 秒阈值，不为 bash 增加同步等待参数。

**Blocked by:** None (can start immediately).

**Status:** done

- [x] 从工具参数、管理器和当前使用说明中移除 wait，不保留兼容入口。
- [x] 移除指向 wait 的提示，在交接返回中集中说明通知、独立工作及结束轮次；保留原生 bash 的无关 guidelines。
- [x] 公开工具校验拒绝 wait；真实会话和 RPC 不靠 wait 或轮询接收完成及超时结果。
- [x] status、kill、通知归属、重载、退出清理、短任务 ID 和执行超时保持正确。
- [x] 验证通过后更新本地记录并提交所有本轮相关改动；不调用外部模型 API，不改全局配置。
