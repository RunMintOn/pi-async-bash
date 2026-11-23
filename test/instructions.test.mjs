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
      tools: mode === "direct" ? ["bash", "bash_task"] : ["bash", "bash_task", "codemode"],
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
      assert.match(guidance, /completion message will resume the original conversation/);
      assert.match(guidance, /Rerunning the command can repeat its side effects/);
      assert.match(guidance, /Use bash_task with wait_seconds: 0/);
      if (mode === "direct") {
        assert.match(modelText, /- bash: Execute bash commands/);
        assert.match(modelText, /- bash_task:/);
        assert.deepEqual(Object.keys(declarations.find(tool => tool.name === "bash").parameters.properties), ["command", "timeout"]);
      }
      const tools = ["bash", "bash_task"].map(name => h.runtime.session.getToolDefinition(name));
      for (const tool of tools) {
        assert(tool.promptSnippet);
        assert(tool.outputSchema);
      }
      assert.deepEqual(Object.keys(tools[1].parameters.properties), ["task_id", "wait_seconds"]);
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
