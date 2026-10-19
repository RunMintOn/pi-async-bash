// One-job worker used only to test exit-result persistence without its launcher.
import { spawn } from "node:child_process";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, command, timeoutMs] = process.argv.slice(2);
const save = (state) => {
  writeFileSync(join(dir, "state.tmp"), JSON.stringify(state));
  renameSync(join(dir, "state.tmp"), join(dir, "state.json"));
};
const fd = openSync(join(dir, "output.log"), "w");
const child = spawn("/bin/bash", ["-c", command], {
  detached: true, stdio: ["ignore", fd, fd],
});
closeSync(fd);
let timer;
let timedOut = false;
save({ status: "running", worker_pid: process.pid, shell_pid: child.pid });
child.once("error", (error) => {
  clearTimeout(timer);
  save({ status: "failed_to_start", error: error.message });
});
if (timeoutMs) timer = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
}, Number(timeoutMs));
child.once("exit", (exit_code, signal) => {
  clearTimeout(timer);
  save({ status: timedOut ? "timed_out" : "exited", exit_code, signal });
});
