import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

type Result = AgentToolResult<unknown> & { structuredContent?: unknown; isError?: boolean };
export type TaskStatus = "running" | "exited" | "killed" | "timed_out" | "failed" | "unknown";
export interface TaskRecord {
  task_id: string;
  owner_session_id: string;
  cwd: string;
  status: TaskStatus;
  log_path: string;
  started_at: number;
  finished_at?: number;
  exit_code: number | null;
  total_bytes: number;
  total_lines: number | null;
  error?: string;
}
interface LiveTask {
  record: TaskRecord;
  controller: AbortController;
  handed: boolean;
  stopRequested: boolean;
  done: Promise<void>;
}
type Outcome = { result: Result } | { error: Error };
const handoffMs = 63_000;
const taskIdPattern = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

export function eventId(task: TaskRecord) {
  return `${task.task_id}:terminal`;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("Task control aborted.")); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export class TaskManager {
  private readonly instance = randomUUID();
  private readonly live = new Map<string, LiveTask>();
  private readonly listeners = new Set<(record: TaskRecord) => void>();
  private closing = false;

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private save(record: TaskRecord) {
    const path = join(this.directory, `${record.task_id}.json`);
    const temporary = `${path}.${this.instance}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, path);
  }

  subscribe(listener: (record: TaskRecord) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async execute(options: {
    owner: string;
    cwd: string;
    timeout?: number;
    signal?: AbortSignal;
    run: (signal: AbortSignal, log: (data: Buffer) => void, started: () => void) => Promise<Result>;
  }): Promise<Result> {
    if (this.closing) throw new Error("pi is shutting down.");
    let id: string;
    let fd: number;
    while (true) {
      id = randomBytes(4).toString("hex");
      if (this.live.has(id) || existsSync(join(this.directory, `${id}.json`))) continue;
      try {
        // Exclusive creation also reserves the ID against other pi processes.
        fd = openSync(join(this.directory, `${id}.log`), "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const record: TaskRecord = {
      task_id: id, owner_session_id: options.owner,
      cwd: options.cwd, status: "running", log_path: join(this.directory, `${id}.log`),
      started_at: Date.now(), exit_code: null, total_bytes: 0, total_lines: 0,
    };
    const controller = new AbortController();
    let finish!: () => void;
    const task: LiveTask = {
      record, controller, handed: false, stopRequested: false,
      done: new Promise<void>((resolve) => { finish = resolve; }),
    };
    this.live.set(id, task);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastByte: number | undefined;
    let newlines = 0;
    let logError: Error | undefined;
    let release!: () => void;
    const threshold = new Promise<"handoff">((resolve) => { release = () => resolve("handoff"); });
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const started = () => {
      record.started_at = Date.now();
      // A shorter execution timeout must settle as a foreground timeout.
      if (options.timeout === undefined || options.timeout * 1000 > handoffMs) timer = setTimeout(release, handoffMs);
    };
    const log = (data: Buffer) => {
      if (logError) return;
      try {
        let offset = 0;
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
        record.total_bytes += data.length;
        for (const byte of data) if (byte === 10) newlines++;
        if (data.length) lastByte = data[data.length - 1];
        record.total_lines = newlines + (lastByte !== undefined && lastByte !== 10 ? 1 : 0);
      } catch (error) {
        logError = error instanceof Error ? error : new Error(String(error));
        controller.abort();
      }
    };
    const settle = (outcome: Outcome): Outcome => {
      if (timer) clearTimeout(timer);
      record.finished_at = Date.now();
      if ("result" in outcome) {
        const data = outcome.result.structuredContent as { exit_code?: number } | undefined;
        record.exit_code = data?.exit_code ?? null;
        record.status = "exited";
      } else {
        record.error = truncateTail(logError?.message ?? outcome.error.message, { maxLines: 1, maxBytes: 1024 }).content;
        record.status = logError ? "failed" : task.stopRequested ? "killed" :
          /Command timed out after [\d.]+ seconds$/.test(outcome.error.message) ? "timed_out" : "failed";
      }
      try {
        closeSync(fd);
        if (task.handed) this.save(record);
      } catch (error) {
        outcome = { error: error instanceof Error ? error : new Error(String(error)) };
        record.error = `Cannot save task result: ${outcome.error.message}`;
        record.status = "failed";
      } finally {
        this.live.delete(id);
        finish();
      }
      if (task.handed) {
        for (const listener of this.listeners) listener({ ...record });
      }
      return outcome;
    };
    const execution = Promise.resolve()
      .then(() => options.run(controller.signal, log, started))
      .then((result) => settle({ result }), (error: unknown) =>
        settle({ error: error instanceof Error ? error : new Error(String(error)) }));
    try {
      const outcome = await Promise.race([execution, threshold]);
      if (outcome !== "handoff" || record.status !== "running" || controller.signal.aborted || this.closing) {
        const completed = outcome === "handoff" ? await execution : outcome;
        if ("error" in completed) throw completed.error;
        return completed.result;
      }
      // Persist before dropping the turn's abort listener: the reference is recoverable even if the turn aborts now.
      this.save(record);
      task.handed = true;
      return {
        content: [{ type: "text", text:
          `Still running after 63 seconds. Task: ${id}\nLog: ${record.log_path}\n` +
          "You will be notified when it finishes. Do not poll. " +
          "Continue work that does not depend on this result. If none remains, end your turn and resume when notified.\n" +
          "The task stops when pi exits; any execution timeout still applies." }],
        details: { ...record },
        structuredContent: { ...record, wall_time_seconds: (Date.now() - record.started_at) / 1000 },
      };
    } catch (error) {
      if (record.status === "running") {
        task.stopRequested = true;
        controller.abort();
        await execution;
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
    }
  }

  get(id: string): TaskRecord {
    if (!taskIdPattern.test(id)) throw new Error("Invalid task_id.");
    const active = this.live.get(id);
    if (active?.handed) return { ...active.record };
    const path = join(this.directory, `${id}.json`);
    if (!existsSync(path)) throw new Error(`Unknown task: ${id}`);
    const record = JSON.parse(readFileSync(path, "utf8")) as TaskRecord;
    if (record.task_id !== id) throw new Error(`Invalid task record: ${id}`);
    if (record.status === "running") {
      // Another pi process may still own it. Never adopt or kill based on a persisted PID.
      return { ...record, status: "unknown", total_lines: null, error: "Execution belongs to an unavailable pi runtime; exit result is unknown." };
    }
    return record;
  }

  async control(id: string, action: "status" | "kill", signal?: AbortSignal): Promise<Result> {
    let record = this.get(id);
    if (action === "kill" && record.status === "running") {
      const task = this.live.get(id)!;
      task.stopRequested = true;
      task.controller.abort();
      await abortable(task.done, signal);
      record = this.get(id);
    }
    return this.describe(record, action !== "status");
  }

  describe(record: TaskRecord, reportFailure = false): Result {
    const size = statSync(record.log_path).size;
    const fd = openSync(record.log_path, "r");
    let tail: string;
    try {
      const bytes = Buffer.alloc(Math.min(size, 16384 + 4));
      readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      let offset = 0;
      while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
      tail = truncateTail(bytes.subarray(offset).toString("utf8"), { maxLines: 100, maxBytes: 16384 }).content;
    } finally { closeSync(fd); }
    const data = { ...record, total_bytes: size, output: tail, wall_time_seconds:
      ((record.finished_at ?? Date.now()) - record.started_at) / 1000 };
    return {
      content: [{ type: "text", text: `Task ${record.task_id}: ${record.status}; exit_code=${record.exit_code}; ` +
        `${data.wall_time_seconds.toFixed(1)}s\nLog: ${record.log_path} (${record.total_lines ?? "unknown"} lines, ${size} bytes)\n${tail}` }],
      details: { ...data, ...(record.status !== "running" ? { task_event_id: eventId(record) } : {}) },
      structuredContent: data,
      ...(reportFailure && (record.status !== "exited" || record.exit_code !== 0) ? { isError: true } : {}),
    };
  }

  *forSession(owner: string, references: Set<string>): Generator<TaskRecord> {
    const emitted = new Set<string>();
    for (const task of this.live.values()) {
      if (task.handed && (task.record.owner_session_id === owner || references.has(task.record.task_id))) {
        emitted.add(task.record.task_id);
        yield { ...task.record };
      }
    }
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith(".json") || !taskIdPattern.test(file.slice(0, -5))) continue;
      const id = file.slice(0, -5);
      if (emitted.has(id)) continue;
      const record = this.get(id);
      if (record.owner_session_id === owner || references.has(id)) yield record;
    }
  }

  async shutdown() {
    this.closing = true;
    const tasks = [...this.live.values()];
    for (const task of tasks) { task.stopRequested = true; task.controller.abort(); }
    await Promise.all(tasks.map((task) => task.done));
  }
}

const key = Symbol.for("pi-async-bash.managers.v1");
export function getManager(directory: string): TaskManager {
  const globals = globalThis as typeof globalThis & { [key]?: Map<string, TaskManager> };
  const managers = globals[key] ??= new Map();
  let manager = managers.get(directory);
  if (!manager) { manager = new TaskManager(directory); managers.set(directory, manager); }
  return manager;
}
