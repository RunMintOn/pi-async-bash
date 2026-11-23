import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { extensionPath, harness, pi } from "./support.mjs";

const compactPath = resolve("../22-pi-compact-tool/index.ts");
const theme = {
  appearance: "dark", getColorMode: () => "truecolor",
  fg: (_, text) => text, bg: (_, text) => text, bold: text => text, style: text => text,
};

for (const paths of [[extensionPath, compactPath], [compactPath, extensionPath]]) {
  test("compact renderer coexistence: " + (paths[0] === extensionPath ? "async first" : "compact first"),
    { skip: !existsSync(compactPath), timeout: 15000 }, async () => {
      pi.initTheme("dark", false);
      const h = await harness({}, [], {
        extensionPaths: paths,
        binding: { mode: "tui", uiContext: { theme, notify() {}, setStatus() {} } },
      });
      try {
        const first = await h.call("render a command", { command: "printf RENDER_READY" });
        const content = structuredClone(first.content);
        const definition = h.runtime.session.getToolDefinition("bash");
        const row = new pi.ToolExecutionComponent("bash", "render-row", { command: "long command" },
          {}, definition, { requestRender() {} }, h.dir);
        row.updateResult(first);
        for (const style of ["aggregate", "tidy", "claude", "off"]) {
          await h.runtime.session.prompt("/tool-style " + style);
          assert(row.render(100).length > 0);
          row.setExpanded(true);
          assert(row.render(100).length > 0);
          row.setExpanded(false);
        }
        assert.deepEqual(first.content, content, "rendering changed the result");
      } finally { await h.close(); }
    });
}
