import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { extensionPath, harness, pi } from "./support.mjs";

test("direct and codemode requests retain execution guidance and the final tool contract", async t => {
  for (const mode of ["direct", "on", "only"]) {
    const contexts = [];
    const h = await harness({}, mode === "direct" ? [] : [pi.createCodemodeExtension({ mode, models: false })], {
      tools: mode === "direct" ? ["+bash_task"] : ["+codemode"],
      extensionPaths: [extensionPath],
      calls(context) { contexts.push(structuredClone(context)); },
    });
    try {
      await h.runtime.session.prompt("Inspect the available command tools.");
      const system = contexts[0].messages.find(message => message.role === "system");
      const declarations = system.toolsAdded;
      const modelText = getSystemMessageText(system);
      assert.match(modelText, /PI_\*/);
      assert.match(modelText, /end your turn; Pi will resume the conversation when the result is ready/);
      assert.match(modelText, /Do not rerun the command just to get its result, since that can repeat its side effects/);
      assert.match(modelText, /Do not poll .* by sleeping, repeatedly reading logs, or repeatedly calling bash_task/);
      assert.match(modelText, /A sleep call can keep you waiting even after the command has finished/);
      assert.match(modelText, /Use bash_task with wait_seconds: 0/);
      assert.match(modelText, /If the user explicitly asks to block on an existing task, make one bounded bash_task call/);
      const bash = declarations.find(tool => tool.name === "bash");
      const bashTask = declarations.find(tool => tool.name === "bash_task");
      assert.equal(declarations.find(tool => tool.name === "bash_sync"), undefined);
      assert.match(modelText, /- bash: Run Bash commands with background handoff/);
      assert.match(modelText, /- bash_task: Inspect a handed-off Bash task/);
      assert.match(bash.parameters.properties.timeout.description, /Maximum command runtime in seconds, including after handoff/);
      assert.match(bashTask.parameters.properties.wait_seconds.description, /Maximum time this call waits for the task to finish/);
      assert.deepEqual(Object.keys(bash.parameters.properties), ["command", "timeout"]);
      assert.deepEqual(bash.parameters.required, ["command"]);
      if (mode !== "direct") {
        const codemode = declarations.find(tool => tool.name === "codemode");
        assert.match(codemode.description, /### `bash_sync`/);
        assert.doesNotMatch(codemode.description, /### `(?:bash|bash_task)`/);
      }
      const tools = ["bash", "bash_task", "bash_sync"].map(name => h.runtime.session.getToolDefinition(name));
      for (const tool of tools) {
        assert(tool.outputSchema);
        // bash_sync is codemode-only, so it has no entry in the <tools> list.
        if (tool.name !== "bash_sync") assert(tool.promptSnippet);
      }
      assert.deepEqual(Object.keys(tools[1].parameters.properties), ["task_id", "wait_seconds"]);
      assert.deepEqual(Object.keys(tools[2].outputSchema.properties),
        ["output", "truncated", "full_output_path", "exit_code", "wall_time_seconds"]);
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
