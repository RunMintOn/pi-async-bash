import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { extensionPath, harness, pi } from "./support.mjs";

test("direct and codemode requests retain execution guidance and the final tool contract", async t => {
  for (const mode of ["direct", "only"]) {
    const contexts = [];
    const h = await harness({}, mode === "direct" ? [] : [pi.createCodemodeExtension({ mode: "only", models: false })], {
      tools: mode === "direct" ? ["bash", "write_stdin"] : ["bash", "write_stdin", "codemode"],
      extensionPaths: [extensionPath],
      calls(context) { contexts.push(structuredClone(context)); },
    });
    try {
      await h.runtime.session.prompt("Inspect the available command tools.");
      const system = contexts[0].messages.find(message => message.role === "system");
      const declarations = system.toolsAdded;
      const modelText = getSystemMessageText(system);
      const guidance = mode === "direct" ? modelText : declarations.find(tool => tool.name === "codemode").description;
      assert.match(guidance, /PI_\*/);
      assert.match(guidance, /blocking sleep or wait calls longer than 60 seconds/);
      assert.match(guidance, /no completion notification/i);
      assert.match(guidance, /session_id.*write_stdin/);
      if (mode === "direct") {
        assert.match(modelText, /- bash: Execute bash commands/);
        assert.match(modelText, /- write_stdin:/);
        assert.equal(declarations.find(tool => tool.name === "bash").parameters.properties.workdir, undefined);
      }
      const tools = ["bash", "write_stdin"].map(name => h.runtime.session.getToolDefinition(name));
      for (const tool of tools) {
        assert(tool.promptSnippet);
        assert(tool.outputSchema.required.includes("truncated"));
        assert(tool.outputSchema.required.includes("wall_time_seconds"));
      }
      const fields = tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        outputSchema: tool.outputSchema, promptSnippet: tool.promptSnippet ?? null,
        promptGuidelines: tool.promptGuidelines ?? null,
      });
      const artifact = join(h.dir, "tool-instructions.json");
      writeFileSync(artifact, JSON.stringify({
        mode, native: fields(pi.createBashToolDefinition(h.dir)), plugin: tools.map(fields), contexts,
      }, null, 2));
      t.diagnostic(`${mode} instruction artifact: ${artifact}`);
    } finally { await h.close(); }
  }
});
