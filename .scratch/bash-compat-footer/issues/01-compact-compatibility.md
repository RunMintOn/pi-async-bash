# 01: 双扩展兼容与后台交接展示

**What to build:** async-bash 负责 bash 执行，compact 保留现有展示与修改记录。两个扩展可同时加载，工具行用英文明确记录后台交接。

**Blocked by:** None (can start immediately).

**Status:** done

- [x] 真实资源加载支持两种加载顺序，无重复 bash 冲突。
- [x] 真实会话执行保留 async 描述、短命令输出、63 秒交接和完成通知。
- [x] compact 的 aggregate、tidy、claude 显示 Backgrounded；off 保持原始结果，模型收到的结果不变。
- [x] compact 的现有展示、reload 和 edit/write 修改记录测试通过。
