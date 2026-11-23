import { randomUUID } from "node:crypto";
import { closeSync, createWriteStream, mkdtempSync, openSync, readSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

export const handoffMs = 30_000;
export const maxWaitSeconds = 300;
const previewBytes = 4 * 1024;
const previewLines = 40;

export interface Handoff {
  status: "running";
  task_id: string;
  log_path: string;
}

export interface TaskResult extends Omit<Handoff, "status"> {
  status: "running" | "exited" | "timed_out" | "stopped" | "failed";
  exit_code?: number;
  error?: string;
  log_error?: string;
  output_tail: string;
  truncated: boolean;
  start_line?: number;
  end_line?: number;
  partial_line?: boolean;
}

interface Task {
  ref: Handoff;
  owner: string;
  started_at: number;
  controller: AbortController;
  handed: boolean;
  delivered: boolean;
  bytes: number;
  newlines: number;
  lastByte?: number;
  done: Promise<void>;
  final?: Pick<TaskResult, "status" | "exit_code" | "error" | "log_error">;
}

interface Execution {
  signal: AbortSignal;
  start: (timeout?: number) => void;
  log: (data: Buffer) => boolean;
  exited: (exitCode: number | null) => void;
  timedOut: () => void;
}

function utf8Start(bytes: Buffer, offset: number) {
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
  return offset;
}

function preview(task: Task, status: TaskResult["status"]): TaskResult {
  const result: TaskResult = { ...task.ref, status, output_tail: "", truncated: false };
  if (!task.bytes) return result;

  // Read one extra byte to know if the first visible line starts inside a line.
  const windowStart = Math.max(0, task.bytes - previewBytes);
  const readStart = Math.max(0, windowStart - 1);
  const bytes = Buffer.alloc(task.bytes - readStart);
  const fd = openSync(task.ref.log_path, "r");
  try { readSync(fd, bytes, 0, bytes.length, readStart); }
  finally { closeSync(fd); }

  let start = windowStart - readStart;
  let partial = start > 0 && bytes[0] !== 10;
  if (partial) {
    const newline = bytes.indexOf(10, start);
    if (newline !== -1 && newline < bytes.length - 1) {
      start = newline + 1;
      partial = false;
    } else {
      start = utf8Start(bytes, start);
    }
  }
  const text = new TextDecoder("utf-8", { ignoreBOM: true })
    .decode(bytes.subarray(start), { stream: status === "running" });
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let first = lines.length;
  let count = 0;
  while (first > 0 && lines.length - first < previewLines) {
    const line = lines[first - 1];
    const size = Buffer.byteLength(line);
    if (count + size > previewBytes) {
      if (first === lines.length) {
        const raw = Buffer.from(line);
        lines[--first] = raw.subarray(utf8Start(raw, raw.length - previewBytes)).toString();
        partial = true;
      }
      break;
    }
    count += size;
    first--;
  }
  result.output_tail = lines.slice(first).join("");
  result.truncated = windowStart > 0 || first > 0 || partial;
  if (result.output_tail) {
    const end = task.newlines + Number(task.lastByte !== 10 && !text.endsWith("\n"));
    result.end_line = end;
    result.start_line = end - (lines.length - first) + 1;
    if (partial) result.partial_line = true;
  }
  return result;
}

function describe(task: Task): TaskResult {
  return { ...preview(task, task.final?.status ?? "running"), ...task.final };
}

export class TaskManager {
  private directory?: string;
  private readonly tasks = new Map<string, Task>();
  private readonly listeners = new Set<() => void>();
  private readonly initialWaitMs: number;

  constructor(initialWaitMs = handoffMs) {
    this.initialWaitMs = initialWaitMs;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  async execute<T>(
    owner: string, signal: AbortSignal | undefined, run: (execution: Execution) => Promise<T>,
  ): Promise<T | Handoff> {
    this.directory ??= mkdtempSync(join(tmpdir(), "pi-async-bash-"));
    const task_id = randomUUID();
    const log_path = join(this.directory, `${task_id}.log`);
    const fd = openSync(log_path, "wx", 0o600);
    const stream = createWriteStream(log_path, { fd });
    const controller = new AbortController();
    const task: Task = {
      ref: { status: "running", task_id, log_path }, owner, started_at: Date.now(),
      controller, handed: false, delivered: false, bytes: 0, newlines: 0,
      done: Promise.resolve(),
    };
    this.tasks.set(task_id, task);

    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handoff!: (value: "handoff") => void;
    const threshold = new Promise<"handoff">(resolve => { handoff = resolve; });
    let timedOut = false;
    let logError: string | undefined;
    const logFinished = finished(stream).catch((error: Error) => {
      logError = `Cannot write the complete command log: ${error.message}`;
      abort();
    });
    const execution = (async () => {
      let exit_code: number | undefined;
      let outcome: { result: T } | { error: unknown };
      try {
        const result = await run({
          signal: controller.signal,
          start: timeout => {
            task.started_at = Date.now();
            if (timeout === undefined || timeout * 1000 > this.initialWaitMs) {
              timer = setTimeout(handoff, this.initialWaitMs, "handoff");
            }
          },
          log: data => {
            if (logError) return false;
            stream.write(data, error => {
              if (error) return;
              task.bytes += data.length;
              for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, i + 1)) task.newlines++;
              if (data.length) task.lastByte = data[data.length - 1];
            });
            return !task.handed;
          },
          exited: code => { exit_code = code ?? undefined; },
          timedOut: () => { timedOut = true; },
        });
        outcome = { result };
      } catch (error) {
        outcome = { error };
      } finally {
        clearTimeout(timer);
        stream.end();
        await logFinished;
      }
      if (task.handed) {
        task.final = logError ? { status: "failed", log_error: logError } :
          "result" in outcome ? { status: "exited", exit_code } :
          timedOut ? { status: "timed_out" } :
          controller.signal.aborted ? { status: "stopped" } :
          { status: "failed", error: (outcome.error as Error).message };
        this.changed();
      } else {
        unlinkSync(log_path);
        this.tasks.delete(task_id);
      }
      return logError ? { error: new Error(logError) } : outcome;
    })();
    task.done = execution.then(() => {});

    try {
      const first = await Promise.race([execution, threshold]);
      if (first === "handoff" && this.tasks.has(task_id) && !controller.signal.aborted) {
        task.handed = true;
        this.changed();
        return task.ref;
      }
      const outcome = first === "handoff" ? await execution : first;
      if ("error" in outcome) throw outcome.error;
      return outcome.result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private get(owner: string, id: string): Task {
    const task = this.tasks.get(id);
    if (!task?.handed || task.owner !== owner) throw new Error(`Unknown or unavailable bash task: ${id}`);
    return task;
  }

  async wait(owner: string, id: string, seconds: number, signal?: AbortSignal): Promise<TaskResult> {
    const task = this.get(owner, id);
    signal?.throwIfAborted();
    if (!task.final && seconds > 0) {
      let timer: ReturnType<typeof setTimeout>;
      let abort: () => void;
      await Promise.race([task.done, new Promise<void>((resolve, reject) => {
        timer = setTimeout(resolve, seconds * 1000);
        abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
      })]).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      });
    }
    signal?.throwIfAborted();
    return describe(task);
  }

  markDelivered(owner: string, id: string) {
    const task = this.tasks.get(id);
    if (task?.owner === owner && task.final) task.delivered = true;
  }

  async stop(owner: string, id: string) {
    const task = this.get(owner, id);
    task.controller.abort();
    await task.done;
  }

  running(owner: string) {
    return [...this.tasks.values()].filter(task => task.owner === owner && task.handed && !task.final);
  }

  takeCompletions(owner: string, limit = Infinity): TaskResult[] {
    const results: TaskResult[] = [];
    for (const task of this.tasks.values()) {
      if (task.owner !== owner || !task.final || task.delivered) continue;
      results.push(describe(task));
      task.delivered = true;
      if (results.length === limit) break;
    }
    return results;
  }

  async shutdown() {
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.all(tasks.map(task => task.done));
    if (this.directory) rmSync(this.directory, { recursive: true });
    this.tasks.clear();
    this.directory = undefined;
  }
}

const key = Symbol.for("pi-async-bash.handoff-managers");
export function getManager(agentDir: string): TaskManager {
  const globals = globalThis as typeof globalThis & { [key]?: Map<string, TaskManager> };
  const managers = globals[key] ??= new Map();
  let manager = managers.get(agentDir);
  if (!manager) {
    manager = new TaskManager();
    managers.set(agentDir, manager);
  }
  return manager;
}
