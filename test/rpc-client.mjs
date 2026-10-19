import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { packageRoot, extensionPath } from "./support.mjs";

export class TestRpc {
  constructor(dir = mkdtempSync(join(tmpdir(), "pi-async-rpc-"))) {
    this.dir = dir;
    this.events = [];
    this.waiters = new Set();
    this.sequence = 0;
    this.stderr = "";
    this.child = spawn(process.execPath, [
      join(packageRoot, "dist/bundle/cli.js"),
      "--mode", "rpc", "--offline", "--no-extensions", "--no-mcp",
      "--no-skills", "--no-context-files", "--no-prompt-templates",
      "-e", extensionPath, "-e", resolve("test/fixtures/provider.ts"), "-e", "builtin:codemode",
      "--provider", "async-test", "--model", "scripted", "--thinking", "off",
      "--tools", "bash,bash_task,codemode", "--session-dir", join(dir, "sessions"),
    ], {
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { throw new Error(`Non-JSON RPC stdout: ${line}`); }
        const record = { ...event, observed_at: Date.now() };
        this.events.push(record);
        for (const waiter of [...this.waiters]) if (waiter.predicate(record)) waiter.resolve(record);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (s) => { this.stderr += s; });
    this.exited = once(this.child, "exit");
  }
  async ready() { return this.send("get_state"); }
  wait(predicate, since = 0, timeout = 45000) {
    const existing = this.events.slice(since).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error(`RPC event deadline\n${this.stderr}`)); }, timeout);
      const waiter = {
        predicate,
        resolve: (event) => { clearTimeout(timer); this.waiters.delete(waiter); resolve(event); },
        reject: (error) => { clearTimeout(timer); this.waiters.delete(waiter); reject(error); },
      };
      this.waiters.add(waiter);
    });
  }
  async send(type, data = {}) {
    const id = `r${++this.sequence}`;
    const response = this.wait((e) => e.type === "response" && e.id === id);
    this.child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
    const result = await response;
    assert.equal(result.success, true, result.error);
    return result.data;
  }
  async prompt(message) {
    const since = this.events.length;
    await this.send("prompt", { message, streamingBehavior: "steer" });
    const user = await this.wait((e) => e.type === "message_end" && e.message.role === "user" &&
      (typeof e.message.content === "string" ? e.message.content :
        e.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")) === message, since);
    await this.wait((e) => e.type === "agent_settled", this.events.indexOf(user) + 1);
    return this.events.slice(since).filter((e) => e.type === "message_end" && e.message.role === "toolResult").map((e) => e.message);
  }
  call(name, args) {
    return this.prompt("CALL " + JSON.stringify([{ name, args }])).then((results) => results.at(-1));
  }
  save() {
    writeFileSync(join(this.dir, `events-${this.child.pid}.jsonl`), this.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(join(this.dir, `stderr-${this.child.pid}.log`), this.stderr);
  }
  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end();
      const deadline = setTimeout(() => this.child.kill("SIGKILL"), 5000);
      await this.exited;
      clearTimeout(deadline);
    }
    this.save();
    for (const waiter of this.waiters) waiter.reject(new Error("RPC closed"));
  }
}
