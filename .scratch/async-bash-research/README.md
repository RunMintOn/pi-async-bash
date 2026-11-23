# 异步 Shell 机制档案

只读研究，对象是 pi 内置 bash，以及 Codex、OpenCode、Amp、Unreal Agent 四个产品的 shell 执行链路。不含对本地实现的建议。

## 快速定位

| 产品 | 一句话 | 模型拿到结果的方式 |
|---|---|---|
| pi 内置 | 一次调用包住整条命令 | 调用结束 |
| Codex | 一个持久进程表 + 两个工具 | 自己再调 `write_stdin` |
| OpenCode | 前台调用就是 job，可中途转后台 | 完成时收到合成消息并自动唤醒 |
| Amp | 四个 shell 工具，pid 是全局句柄 | 自己 `shell_command_status`，或 `mode:"async"` 收消息 |
| Unreal Agent | 工具结果允许先不完整 | 占位结果被真实结果替换，并再调一次模型 |

## 文件

- `codex.md`：`exec_command` / `write_stdin`，进程表、输出预算、终止路径。
- `opencode.md`：`shell` 工具、Job 状态机、合成消息与重启恢复。
- `amp.md`：`shell_command` / `async_shell_command` / `shell_command_status` / `shell_command_kill`。
- `unreal-agent.md`：Bash 工具、operation 状态机、占位结果与心跳。
- `comparison.md`：以 pi 内置 bash 为基线，五方横向对照。

## 版本

| 产品 | 锚点 |
|---|---|
| Codex | commit `04e365c69`，2026-10-28 |
| OpenCode | commit `843a6c514e`，v2.0.32，2026-10-16 |
| Amp | `0.0.1794196844-g44d37b`，2026-11-09；Mach-O `__BUN` 段 `fileoff 88227840`、`filesize 40206336` |
| Unreal Agent | commit `a5f3fd1`，2026-10-06 |

Amp 无源码，证据来自 `~/20-dev/10-projects/temp/amp-cli-probe/bundle.js`（7,809,508 字符，UTF-16LE 明文抽取）。升级后重跑：

```bash
cd ~/20-dev/10-projects/temp/amp-cli-probe
python3 extract-js.py amp bundle.js
```

## 读法约定

- 证据写成 `path:line`；Amp 写成 `bundle.js` 字符偏移加可 grep 的原文片段。
- 引号内是逐字原文，未改动大小写与标点。
- 标「推断」的条目没有直接证据，只有结构或文案支持。
- 标「未验证」的条目需要实机运行才能确认。
