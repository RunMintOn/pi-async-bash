# Pi 工具可见性：实测规则与验证手法

基线 Pi 1.6.0，扩展 `index.ts`。本文只记代码与官方文档读不出来的结论，改工具分工或写可见性断言前先读。分工的取舍理由见 [PROMPT_DESIGN.md](PROMPT_DESIGN.md)，契约见 [SPEC.md](SPEC.md)。

## 1. `exposure` 与激活集

`exposure` 决定模型怎么够到工具，激活集决定 `direct` / `model-only` 工具是否声明给模型。

- `codemode` 的「不声明给模型」只在它没进激活集时成立。文档原文是「Not declared to the model unless activated explicitly」（`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` 的 Tool Exposure 段）。
- 因此 `codemode` 工具一旦被 `--tools`、`defaultTools` 或 `setActiveTools()` 点名，就会和 `direct` 工具一样出现在 `tools[]` 里，同时仍可被脚本调用。
- `codemode` 的 `only` 模式只隐藏 `direct` exposure 的声明（`dist/extensions/codemode/tool.js` 的 `prepareCodemodeLoadout`，`hiddenDeclarations` 只取 `isDirect`）。`model-only` 的 `bash`、`bash_task` 在 `only` 下照旧声明。
- `codemode` 工具的 snippet、description、guidelines 都不会进 `<tools>` 清单和 `<rules>`。其 description 与 TypeScript 声明由 codemode 工具描述列出。

## 2. `--tools` 的两种写法后果不同

`dist/core/sdk.js` 里，只有修饰写法才让 `allowedToolNames` 变成 `undefined`。

| 写法 | 注册白名单 | 声明给模型 |
|---|---|---|
| `--tools bash,bash_task` | 是，未列入的扩展工具整个不注册 | 只声明列出的名字 |
| `--tools +codemode` | 否 | 默认工具集加 `codemode`，扩展工具全部保留 |

后果：普通名列表里写进一个 `codemode` 工具（例如 `bash_sync`），既会让它在脚本里消失一次风险之外的副作用——它还会被直接声明给模型，破坏「脚本侧工具只出现在脚本里」的设计。混合模式的正确写法是 `--tools +codemode`。

普通名列表与 `+name` 不能混用，乱写由 `getToolListError` 报错。

## 3. 三种模式的真实声明形状

`test/instructions.test.mjs` 捕获三种请求，断言已固化：

- 未启用 codemode：`bash`、`bash_task` 直接声明，`bash_sync` 不在声明里，`<rules>` 只有两个工具的直接规则。
- `on`：`bash`、`bash_task` 仍直接声明。`codemode` 描述里以 `### `bash_sync`` 列出它，不给 `bash` / `bash_task` 单独开标题。声明中且可调用的工具，其 description 尾部追加 `Codemode: tools.x(args) resolves to ...`。
- `only`：`direct` 工具隐藏，`bash` / `bash_task`（`model-only`）仍直接声明。

## 4. 踩过的坑

- **不要断言 `tools.bash` 的纠错文案。** 实际抛 `TypeError: tools.bash does not exist. Did you mean tools.bash_sync?`，但「Did you mean」是 QuickJS 按名字距离猜的，换名字就变。断言 `tools.bash does not exist` 即可。
- **`bash_sync` 的 `timeout` 会真的杀进程。** 原生 `createBashToolDefinition` 的 `timeout` 语义是命令行寿命，脚本里超时会中断命令，不是只中断等待。
- **结构化输出与文本输出上限不同。** 文本按 2000 行 / 50 KiB 截断，脚本拿到的 `output` 上限 1 MiB，`truncated` 与 `full_output_path` 只在结构化输出侧有意义。
- **直接复用 `createBashToolDefinition` 要自己传 `shellPath` 和 `commandPrefix`。** 不传就退回默认 shell，和 `bash` 的行为不一致。需要 tee 日志时再包 `operations.exec`，见 `index.ts` 的 `bash` 分支。
- **`harness()` 默认把扩展模式当成 `print`。** Pi SDK 的 `createAgentSessionRuntime` 和 `runner.setUIContext` 默认 `mode: "print"`，不在 `bindExtensions` 里传 `mode` 就一直是 `print`。后果：任何按 `ctx.mode` 分支的行为（例如 `bash` 的一次性执行路径）在 harness 测试里都走一次性那支。2026-11 就因此让 `test/cache-prefix.test.mjs` 假装常驻会话时拿不到交接，任务永不完成、测试 55 秒超时。**要模拟交互式或 RPC 会话，传 `binding: { mode: "rpc" }` 给 `harness()` 的第三个参数。**
- **子进程形式的 Pi 必须先关 stdin。** `pi -p` 与 `--mode json` 在 `stdin` 不是 TTY 时会先读完管道再启动（`resolveAppMode` 与 `readPipedStdin`）。用 `execFile` 起子进程却不写也不关 `child.stdin`，Pi 会卡在启动阶段直到外层超时。写完后 `run.child.stdin.end()`。RPC 模式例外，它把 stdin 当协议通道。

## 5. 验证手法

`harness()` 两个参数决定可见性验证，第三个参数决定运行模式：

```js
harness(settings, extensionFactories, {
  tools: ["+codemode"],              // 可用修饰写法，绕过注册白名单
  binding: { mode: "rpc" },          // 不传就是 print，按 ctx.mode 分支的工具会走一次性路径
  calls(context) { /* 捕获真实请求 */ },
});
```

`context.messages[0].toolsAdded` 是本次请求声明给模型的工具，含 `name`、`description`、`parameters`、`promptSnippet`、`promptGuidelines`、`outputSchema`。系统提示正文用 `@earendil-works/pi-ai` 的 `getSystemMessageText(system)`。

脚本侧可见性用真实 RPC 验证，比 SDK harness 更接近生产。`test/rpc-client.mjs` 固定 `--tools +codemode`，`test/rpc.test.mjs` 用 `ALL_TOOLS` 确认脚本只能看到 `bash_sync`。

耗时参考：整套 `npm test` 约 75 秒，其中缓存前缀约 30 秒、RPC 旅程约 39 秒。断言可见性只需 `node --test test/instructions.test.mjs`，1 秒内出结果。

## 6. 未验证

- 真实模型在三工具之间的选择倾向，只用脚本化模型验证过声明形状。
- `codemode` 全局 worker 上限默认 2，可由 `PI_CODEMODE_MAX_WORKERS` 改变；`bash_sync` 描述只写占用一个 worker，不写具体数字。
