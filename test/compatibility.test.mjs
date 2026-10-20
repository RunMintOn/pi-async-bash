import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { extensionPath, harness, eventOnce, pi, textOf } from "./support.mjs";

const compactPath = resolve("../22-pi-compact-tool/index.ts");
const theme = {
  appearance: "dark", getColorMode: () => "truecolor",
  fg: (_, text) => text, bg: (_, text) => text, bold: text => text, style: text => text,
};

for (const paths of [[extensionPath, compactPath], [compactPath, extensionPath]]) {
  test(`compact compatibility: ${paths[0] === extensionPath ? "async first" : "compact first"}`,
    { skip: !existsSync(compactPath), timeout: 15000 }, async (t) => {
      pi.initTheme("dark", false);
      const h = await harness({ shellCommandPrefix: "export ASYNC_COMPAT=ok;" }, [], {
        extensionPaths: paths,
        binding: { mode: "tui", uiContext: { theme, notify() {}, setStatus() {} } },
      });
      try {
        const definition = h.runtime.session.getToolDefinition("bash");
        assert.match(definition.description, /After 63 seconds/);
        const short = await h.call("short", { command: "printf \"$ASYNC_COMPAT\"; exit 7" });
        assert.equal(short.isError, true);
        assert.match(textOf(short), /^ok[\s\S]*Command exited with code 7/);

        t.mock.timers.enable({ apis: ["setTimeout"] });
        const gate = join(h.dir, "finish");
        const ready = eventOnce(h.runtime.session, e =>
          e.type === "tool_execution_update" && textOf(e.partialResult).includes("COMPAT_READY"));
        const running = h.call("handoff", {
          command: `printf COMPAT_READY; while [ ! -f '${gate}' ]; do sleep 0.02; done; printf COMPAT_DONE; exit 9`,
        });
        await ready;
        t.mock.timers.tick(63000);
        const handed = await running;
        assert.equal(handed.details.status, "running");
        assert.equal(handed.details.exit_code, null);
        assert.match(textOf(handed), /Still running after 63 seconds/);

        const row = new pi.ToolExecutionComponent("bash", "compat-row", { command: "long command" },
          {}, definition, { requestRender() {} }, h.dir);
        row.updateResult(handed);
        for (const style of ["aggregate", "tidy", "claude"]) {
          await h.runtime.session.prompt(`/tool-style ${style}`);
          assert.match(row.render(100).join("\n"), /Backgrounded/);
          row.setExpanded(true);
          assert.match(row.render(100).join("\n"), /Still running/);
          row.setExpanded(false);
        }
        await h.runtime.session.prompt("/tool-style off");
        assert.match(row.render(100).join("\n"), /Still running/);
        assert.equal(handed.details.status, "running", "rendering must not rewrite the tool result");

        const completed = eventOnce(h.runtime.session, e => e.type === "agent_settled" &&
          h.runtime.session.messages.some(m => m.role === "custom" && m.details?.task_id === handed.details.task_id));
        writeFileSync(gate, "");
        await completed;
        const notices = h.runtime.session.messages.filter(m => m.role === "custom" &&
          m.details?.task_id === handed.details.task_id);
        assert.equal(notices.length, 1);
        assert.match(textOf(notices[0]), /exit_code=9/);
        assert(h.requests.some(r => r.texts.some(s => s.includes("COMPAT_DONE"))));
      } finally {
        t.mock.timers.reset();
        await h.close();
      }
    });
}
