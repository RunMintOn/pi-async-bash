import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, node, pi } from "./support.mjs";

test("pipe and PTY commands can find Pi-managed binaries just like native Bash", async () => {
  const h = await harness({ shellPath: "/bin/bash" });
  try {
    const bin = join(h.dir, "agent", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "async-managed-probe"), "#!/bin/sh\nprintf MANAGED_BINARY", { mode: 0o755 });
    let native = "";
    await pi.createLocalBashOperations({ shellPath: "/bin/bash" }).exec("async-managed-probe", h.dir, {
      onData: data => { native += data; },
    });
    assert.equal(native, "MANAGED_BINARY");
    for (const tty of [false, true]) {
      const result = await h.call("managed binary " + tty, { command: "async-managed-probe", tty });
      assert.equal(result.details.exit_code, 0);
      assert.equal(result.details.output, "MANAGED_BINARY");
    }
  } finally { await h.close(); }
});

test("post-exit output drains while active, but quiet inherited pipes do not hold the result open", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    for (const active of [true, false]) {
      const writer = active ? `
        process.stdout.on("error", () => process.exit(0));
        let count = 0;
        setInterval(() => {
          process.stdout.write("tick\\n");
          if (++count === 20) { process.stdout.write("TAIL\\n"); process.exit(0); }
        }, 20);
        process.send("ready");
      ` : 'setTimeout(() => process.exit(0), 2000); process.send("ready");';
      const command = "exec " + node(`
        const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], {
          detached: true, stdio: ["ignore", 1, 2, "ipc"],
        });
        child.once("message", () => {
          child.disconnect();
          process.stdout.write("MAIN\\n", () => process.exit(0));
        });
      `);
      const expected = active ? "MAIN\n" + "tick\n".repeat(20) + "TAIL\n" : "MAIN\n";
      let native = "";
      await pi.createLocalBashOperations().exec(command, h.dir, { onData: data => { native += data; } });
      assert.equal(native, expected);
      const started = performance.now();
      const result = await h.call("inherited pipes " + active, { command });
      assert.equal(result.details.output, expected);
      assert.equal(result.details.exit_code, 0);
      if (!active) assert(performance.now() - started < 1500, "a quiet inherited pipe blocked completion");
    }
  } finally { await h.close(); }
});
