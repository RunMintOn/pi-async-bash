import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TaskManager, TaskRecord } from "./tasks.ts";

export function taskReferences(entries: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const value = entry.type === "custom" && entry.customType === "async-bash-task" ? entry.data :
      entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details : undefined;
    const id = value && typeof value === "object" && "task_id" in value ? value.task_id : undefined;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function backgroundStatus(tasks: readonly TaskRecord[], now: number, width: number): string | undefined {
  if (!tasks.length) return undefined;
  const ages = [...tasks].sort((a, b) => a.started_at - b.started_at)
    .map(task => duration(now - task.started_at));
  const variants = [ages, ages.map(age => age.replaceAll(" ", ""))];
  const prefix = `BG ${tasks.length}`;
  for (let shown = ages.length; shown > 0; shown--) {
    for (const durations of variants) {
      const text = `${prefix} · ${durations.slice(0, shown).join(" / ")}${shown < ages.length ? ` / +${ages.length - shown}` : ""}`;
      if (text.length <= width) return text;
    }
  }
  const compact = `${prefix} · +${ages.length}`;
  return compact.length <= width ? compact : prefix;
}

export function installTaskStatus(pi: ExtensionAPI, ctx: ExtensionContext, manager: TaskManager): () => void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return () => {};
  const owner = ctx.sessionManager.getSessionId();
  let tasks: TaskRecord[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let last: string | undefined;
  const update = () => {
    // Keep the omission count visible if the native footer truncates other statuses.
    const text = backgroundStatus(tasks, Date.now(), Math.max(0, (process.stdout.columns ?? 80) - 3));
    if (text !== last) {
      ctx.ui.setStatus("async-bash", text);
      last = text;
    }
    if (tasks.length && !timer) timer = setInterval(update, 1000).unref();
    if (!tasks.length && timer) { clearInterval(timer); timer = undefined; }
  };
  const refresh = () => {
    const references = taskReferences(ctx.sessionManager.getBranch());
    // Rebuild at lifecycle boundaries; ticking ages needs no disk or log reads.
    tasks = [...manager.forSession(owner, references)].filter(task => task.status === "running");
    update();
  };
  const off = [
    pi.on("tool_execution_end", event => { if (event.toolName === "bash") refresh(); }),
    pi.on("session_tree", refresh),
    pi.on("session_compact", refresh),
    manager.subscribe(record => {
      tasks = tasks.filter(task => task.task_id !== record.task_id);
      update();
    }),
  ];
  process.stdout.on("resize", update);
  refresh();
  return () => {
    for (const unsubscribe of off) unsubscribe();
    process.stdout.off("resize", update);
    if (timer) clearInterval(timer);
    ctx.ui.setStatus("async-bash", undefined);
  };
}
