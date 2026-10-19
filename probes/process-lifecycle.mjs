import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function readUntil(path, accept) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      if (accept(state)) return state;
    } catch {}
    await sleep(15);
  }
  throw new Error(`No expected state at ${path}`);
}

// This short launcher exits. Its detached worker has no inherited stdout pipe.
if (process.argv[2] === "--launch") {
  const child = spawn(process.execPath, [worker, ...process.argv.slice(3)], {
    detached: true, stdio: "ignore",
  });
  await once(child, "spawn");
  console.log(child.pid);
  child.unref();
} else {
  const artifacts = [];
  for (const [name, command, timeout, expected] of [
    ["natural", "sleep 0.4; printf survived; exit 23", "", "exited"],
    ["timeout", "printf partial; sleep 3", "180", "timed_out"],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "pi-job-worker-"));
    artifacts.push(dir);
    const launcher = spawnSync(process.execPath, [
      fileURLToPath(import.meta.url), "--launch", dir, command, timeout,
    ], { encoding: "utf8", timeout: 2000 });
    assert.equal(launcher.status, 0, launcher.stderr);
    const pid = Number(launcher.stdout.trim());
    try {
      process.kill(pid, 0);
      const state = await readUntil(join(dir, "state.json"), (s) => s.status !== "running");
      assert.equal(state.status, expected);
      if (expected === "exited") {
        assert.equal(state.exit_code, 23);
        assert.equal(readFileSync(join(dir, "output.log"), "utf8"), "survived");
      } else {
        assert.equal(state.signal, "SIGKILL");
        assert.equal(state.exit_code, null);
        assert.equal(readFileSync(join(dir, "output.log"), "utf8"), "partial");
      }
      console.log(JSON.stringify({ check: name, launcher_exited_before_worker: true, state, dir }));
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  }

  // Descendants can create a new process group, escaping a group-based kill.
  const dir = mkdtempSync(join(tmpdir(), "pi-job-group-"));
  artifacts.push(dir);
  const pidFile = join(dir, "escaped.pid");
  const escapedScript = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn('/bin/sleep', ['4'], { detached: true, stdio: 'ignore' });
    writeFileSync(process.argv[1], String(child.pid));
    child.unref();
  `;
  const shell = spawn("/bin/bash", ["-c", '"$1" -e "$2" "$3"; sleep 4', "_", process.execPath, escapedScript, pidFile], {
    detached: true, stdio: "ignore",
  });
  let escapedPid;
  try {
    const deadline = Date.now() + 3000;
    while (!escapedPid && Date.now() < deadline) {
      try { escapedPid = Number(readFileSync(pidFile, "utf8")); } catch {}
      if (!escapedPid) await sleep(10);
    }
    assert(escapedPid);
    const shellExit = once(shell, "exit");
    process.kill(-shell.pid, "SIGKILL");
    await shellExit;
    process.kill(escapedPid, 0);
    console.log(JSON.stringify({ check: "escaped_descendant", group_killed: true, detached_descendant_still_alive: true }));
  } finally {
    try { process.kill(-shell.pid, "SIGKILL"); } catch {}
    if (escapedPid) try { process.kill(-escapedPid, "SIGKILL"); } catch {}
  }
  console.log(JSON.stringify({ passed: 3, artifact_directories: artifacts }));
}
