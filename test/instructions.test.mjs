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
      assert.match(guidance, /end your turn; Pi will resume the conversation when the result is ready/);
      assert.match(guidance, /Do not rerun the command just to get its result, since that can repeat its side effects/);
      assert.match(guidance, /Do not poll .* by sleeping, repeatedly reading logs, or repeatedly calling bash_task/);
      assert.match(guidance, /A sleep call can keep you waiting even after the command has finished/);
      assert.match(guidance, /Use bash_task with wait_seconds: 0/);
      assert.match(guidance, /If the user explicitly asks to block on an existing task, make one bounded bash_task call/);
      const bash = declarations.find(tool => tool.name === "bash");
      const bashTask = declarations.find(tool => tool.name === "bash_task");
      assert.match(bash?.parameters.properties.timeout.description ?? guidance, /Maximum command runtime in seconds, including after handoff/);
      assert.match(bashTask?.parameters.properties.wait_seconds.description ?? guidance, /Maximum time this call waits for the task to finish/);
      if (mode === "direct") {
        assert.match(modelText, /- bash: Run Bash commands with background handoff/);
        assert.match(modelText, /- bash_task: Inspect a handed-off Bash task/);
        assert.deepEqual(Object.keys(bash.parameters.properties), ["command", "timeout"]);
        assert.deepEqual(bash.parameters.required, ["command"]);
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
