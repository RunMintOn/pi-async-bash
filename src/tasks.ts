import { randomInt } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as osConstants } from "node:os";
import { closeSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { DEFAULT_MAX_BYTES, truncateTail } from "@earendil-works/pi-coding-agent";
import { spawn as spawnPty } from "node-pty";

export interface ProcessResult {
  output: string;
  truncated: boolean;
  full_output_path?: string;
  exit_code?: number;
  session_id?: number;
}

export interface ProcessRecord {
  session_id: number;
  owner: string;
  started_at: number;
  handed: boolean;
  exit_code?: number;
}

export interface Access {
  owner: string;
  references: Set<number>;
}

interface Execution extends ProcessRecord {
  path: string;
  fd: number;
  bytes: number;
  cursor: number;
  error?: Error;
  done: Promise<void>;
  finish: () => void;
  queue: Promise<void>;
  updates: Set<() => void>;
  write: (text: string) => Promise<void>;
  kill: () => void;
}

function aborted(): Error { return new Error("Command interaction aborted."); }

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function waitingTime(value: number | undefined, kind: "start" | "poll" | "input"): number {
  const [fallback, minimum, maximum] = kind === "start" ? [10000, 250, 30000] :
    kind === "poll" ? [5000, 5000, 300000] : [250, 250, 30000];
  return Math.floor(Math.min(maximum, Math.max(minimum, value ?? fallback)));
}

export class ProcessManager {
  private readonly processes = new Map<number, Execution>();
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private readonly onExit = () => {
    for (const task of this.processes.values()) if (task.exit_code === undefined) task.kill();
  };

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed() { for (const listener of this.listeners) listener(); }

  private get(id: number, access: Access): Execution {
    const task = this.processes.get(id);
    if (!task || (task.owner !== access.owner && !access.references.has(id))) {
      throw new Error("Unknown or unavailable command session: " + id);
    }
    return task;
  }

  async execute(options: {
    owner: string;
    command: string;
    cwd: string;
    shell: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    tty: boolean;
    yield_time_ms?: number;
    signal?: AbortSignal;
    update?: (output: string) => void;
  }): Promise<ProcessResult> {
    if (this.closing) throw new Error("Pi is shutting down.");
    if (process.platform === "win32") throw new Error("This extension currently supports macOS and Linux only.");
    if (options.signal?.aborted) throw aborted();
    let id: number;
    let fd: number;
    let path: string;
    while (true) {
      id = randomInt(1, 0x7fffffff);
      path = join(this.directory, id + ".log");
      try { fd = openSync(path, "wx", 0o600); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    let finish!: () => void;
    const task: Execution = {
      session_id: id, owner: options.owner, started_at: Date.now(), handed: false,
      path, fd, bytes: 0, cursor: 0,
      done: new Promise(resolve => { finish = resolve; }), finish: () => finish(),
      queue: Promise.resolve(), updates: new Set(),
      write: async () => { throw new Error("Command is not ready."); }, kill: () => {},
    };
    this.processes.set(id, task);
    if (this.processes.size === 1) process.once("exit", this.onExit);
    const settle = (code: number, error?: Error) => {
      if (task.exit_code !== undefined) return;
      task.exit_code = code;
      task.error ??= error;
      try { closeSync(task.fd); }
      catch (error) { task.error ??= error instanceof Error ? error : new Error(String(error)); }
      task.write = async () => { throw new Error("Command session has already exited."); };
      task.kill = () => {};
      task.finish();
      this.changed();
    };
    const log = (data: Buffer) => {
      if (task.exit_code !== undefined) return;
      try {
        let offset = 0;
        while (offset < data.length) offset += writeSync(task.fd, data, offset, data.length - offset);
        task.bytes += data.length;
        for (const update of task.updates) update();
      } catch (error) {
        task.error = error instanceof Error ? error : new Error(String(error));
        task.kill();
      }
    };
    try {
      if (options.tty) this.startPty(task, options, log, settle);
      else this.startPipe(task, options, log, settle);
    } catch (error) {
      settle(1, error instanceof Error ? error : new Error(String(error)));
    }
    const abort = () => task.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const result = await this.interact(task, "", waitingTime(options.yield_time_ms, "start"), options.signal, options.update);
      if (options.signal?.aborted) throw aborted();
      task.handed = result.session_id !== undefined;
      this.changed();
      return result;
    } catch (error) {
      if (task.exit_code === undefined) { task.kill(); await task.done; }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private startPipe(
    task: Execution,
    options: { shell: string; args: string[]; command: string; cwd: string; env: NodeJS.ProcessEnv },
    log: (data: Buffer) => void,
    settle: (code: number, error?: Error) => void,
  ) {
    const child: ChildProcessWithoutNullStreams = spawn(options.shell, [...options.args, options.command], {
      cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    task.kill = () => {
      if (!child.pid || task.exit_code !== undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch {} }
    };
    task.write = text => new Promise((resolve, reject) => {
      child.stdin.write(text, error => error ? reject(error) : resolve());
    });
    child.stdin.on("error", () => {});
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let exited = false;
    let code = 1;
    const finish = () => {
      if (drainTimer) clearTimeout(drainTimer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      settle(code);
    };
    // Adapt Pi 1.4.0 waitForChildProcess: active output resets the post-exit grace.
    const armDrainTimer = () => {
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(finish, 100);
    };
    const onData = (data: Buffer) => {
      log(data);
      if (exited) armDrainTimer();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", error => { settle(1, error); });
    child.once("exit", (exitCode, signal) => {
      exited = true;
      code = exitCode ?? (signal ? 128 + osConstants.signals[signal] : 1);
      // Clean the group now; retaining its ID after exit risks signalling a reused group.
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      // Descendants outside the group can still retain inherited pipes.
      armDrainTimer();
    });
    child.once("close", finish);
  }

  private startPty(
    task: Execution,
    options: { shell: string; args: string[]; command: string; cwd: string; env: NodeJS.ProcessEnv },
    log: (data: Buffer) => void,
    settle: (code: number, error?: Error) => void,
  ) {
    const terminal = spawnPty(options.shell, [...options.args, options.command], {
      cwd: options.cwd, env: options.env, name: "xterm-256color", cols: 80, rows: 24,
    });
    task.kill = () => {
      if (task.exit_code !== undefined) return;
      try { process.kill(-terminal.pid, "SIGKILL"); } catch {}
      try { terminal.kill("SIGKILL"); } catch {}
    };
    task.write = async text => { terminal.write(text); };
    const data = terminal.onData(text => log(Buffer.from(text)));
    const exit = terminal.onExit(({ exitCode, signal }) => {
      try { process.kill(-terminal.pid, "SIGKILL"); } catch {}
      data.dispose();
      exit.dispose();
      settle(signal ? 128 + signal : exitCode);
    });
  }

  async input(id: number, chars: string, yieldTime: number | undefined, access: Access,
    signal?: AbortSignal, update?: (output: string) => void): Promise<ProcessResult> {
    return this.interact(this.get(id, access), chars, waitingTime(yieldTime, chars ? "input" : "poll"), signal, update);
  }

  private async interact(task: Execution, chars: string, milliseconds: number,
    signal?: AbortSignal, update?: (output: string) => void): Promise<ProcessResult> {
    const previous = task.queue;
    let release!: () => void;
    task.queue = new Promise(resolve => { release = resolve; });
    let acquired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      if (update && !updateTimer) updateTimer = setTimeout(() => {
        updateTimer = undefined;
        // A failed streaming preview must not crash Pi; the final read reports I/O errors.
        try { update(this.read(task, false).output); } catch {}
      }, 100);
    };
    try {
      await abortable(previous, signal);
      acquired = true;
      if (signal?.aborted) throw aborted();
      if (task.error) throw task.error;
      if (chars && task.exit_code !== undefined) throw new Error("Command session has already exited.");
      task.updates.add(changed);
      if (task.bytes > task.cursor) changed();
      if (task.exit_code === undefined) {
        // Stream writes stay ordered even when backpressure outlasts this interaction.
        const written = chars ? task.write(chars) : Promise.resolve();
        await abortable(Promise.race([
          task.done,
          written.then(() => task.done),
          new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); }),
        ]), signal);
      }
      if (signal?.aborted) throw aborted();
      if (task.error) throw task.error;
      const output = this.read(task, true);
      return task.exit_code === undefined ? { ...output, session_id: task.session_id } : { ...output, exit_code: task.exit_code };
    } finally {
      if (timer) clearTimeout(timer);
      if (updateTimer) clearTimeout(updateTimer);
      task.updates.delete(changed);
      if (acquired) release();
      else void previous.then(release);
    }
  }

  private read(task: Execution, consume: boolean): Pick<ProcessResult, "output" | "truncated" | "full_output_path"> {
    const end = task.bytes;
    const start = Math.max(task.cursor, end - (DEFAULT_MAX_BYTES + 4));
    const buffer = Buffer.alloc(end - start);
    const fd = openSync(task.path, "r");
    try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
    let head = 0;
    if (start > task.cursor) while (head < buffer.length && (buffer[head] & 0xc0) === 0x80) head++;
    let tail = buffer.length;
    if (task.exit_code === undefined && tail > head) {
      let lead = tail - 1;
      while (lead > head && (buffer[lead] & 0xc0) === 0x80) lead--;
      const byte = buffer[lead];
      const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (tail - lead < expected) tail = lead;
    }
    const text = stripVTControlCharacters(buffer.subarray(head, tail).toString("utf8"))
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
    const truncated = truncateTail(text);
    const omitted = start > task.cursor || truncated.truncated;
    if (consume) task.cursor = start + tail;
    return {
      output: omitted ? truncated.content + "\n[Output truncated. Full log: " + task.path + "]" : truncated.content,
      truncated: omitted,
      ...(omitted ? { full_output_path: task.path } : {}),
    };
  }

  async stop(id: number, access: Access): Promise<void> {
    const task = this.get(id, access);
    if (task.exit_code === undefined) { task.kill(); await task.done; }
  }

  *forSession(access: Access): Generator<ProcessRecord> {
    for (const task of this.processes.values()) {
      if (task.owner === access.owner || access.references.has(task.session_id)) yield task;
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.onExit();
    await Promise.all([...this.processes.values()].map(task => task.done));
    process.off("exit", this.onExit);
  }
}

const key = Symbol.for("pi-async-bash.process-managers.v2");
export function getManager(directory: string): ProcessManager {
  const globals = globalThis as typeof globalThis & { [key]?: Map<string, ProcessManager> };
  const managers = globals[key] ??= new Map();
  let manager = managers.get(directory);
  if (!manager) { manager = new ProcessManager(directory); managers.set(directory, manager); }
  return manager;
}
