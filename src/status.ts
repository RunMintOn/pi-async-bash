import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { completionType, taskResult, type TaskManager } from "./tasks.ts";

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m " + String(seconds % 60).padStart(2, "0") + "s";
  return Math.floor(minutes / 60) + "h " + String(minutes % 60).padStart(2, "0") + "m " + String(seconds % 60).padStart(2, "0") + "s";
}

function runningDetail(ages: string[], room: number) {
  const variants = [ages, ages.map(age => age.replaceAll(" ", ""))];
  for (let shown = ages.length; shown > 0; shown--) {
    for (const durations of variants) {
      const text = " · " + durations.slice(0, shown).join(" / ") + (shown < ages.length ? " / +" + (ages.length - shown) : "");
      if (text.length <= room) return text;
    }
  }
  const compact = ` · +${ages.length}`;
  return compact.length <= room ? compact : "";
}

function backgroundStatus(theme: ExtensionContext["ui"]["theme"], started: number[], finished: number, now: number, width: number) {
  const count = started.length;
  if (!count && !finished) return undefined;
  const accent = (text: string) => theme.fg("accent", text);
  const muted = (text: string) => theme.fg("muted", text);
  const brackets = (text: string) => theme.fg("dim", "[") + text + theme.fg("dim", "]");
  const fits = (text: string) => text.length + 2 <= width;
  const ages = started.sort((a, b) => a - b).map(start => duration(now - start));
  if (!finished) {
    const label = `${count} background ${count === 1 ? "task" : "tasks"}`;
    const detail = runningDetail(ages, width - label.length - 2);
    return brackets(accent(label) + (detail ? muted(detail) : ""));
  }

  const pending = finished === 1 ? "result pending" : "results pending";
  const shortPending = accent(String(finished)) + muted(" " + pending);
  if (!count) {
    const label = `${finished} ${finished === 1 ? "task" : "tasks"} finished`;
    return brackets(fits(`${label} · ${pending}`) ? accent(label) + muted(` · ${pending}`) : shortPending);
  }

  const heading = "Background tasks · ";
  const running = `${count} running`;
  const detail = ` (${ages.join(" / ")}) · `;
  const done = `${finished} finished`;
  if (fits(`${heading}${running}${detail}${done}, ${pending}`)) {
    return brackets(muted(heading) + accent(running) + muted(detail) + accent(done) + muted(`, ${pending}`));
  }
  const prefix = fits(`${heading}${running} · ${finished} ${pending}`) ? muted(heading) : "";
  return brackets(prefix + accent(running) + muted(" · ") + shortPending);
}

function reportedTaskId(entry: SessionEntry) {
  if (entry.type === "custom_message" && entry.customType === completionType && entry.display && taskResult(entry.details)) {
    return entry.details.task_id;
  }
  if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "bash_task" &&
      taskResult(entry.message.details) && entry.message.details.status !== "running") {
    return entry.message.details.task_id;
  }
}

export function installTaskStatus(ctx: ExtensionContext, manager: TaskManager): () => void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return () => {};
  const session = ctx.sessionManager;
  const owner = session.getSessionId();
  const reported = new Set<string>();
  let leaf: ReturnType<typeof session.getLeafId> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let last: string | undefined;
  const update = () => {
    const { running, finished } = manager.backgroundTasks(owner);
    if (finished.some(id => !reported.has(id))) {
      // A boundary can claim a completion before Pi adds it to the conversation.
      const currentLeaf = session.getLeafId();
      if (leaf !== currentLeaf) {
        leaf = currentLeaf;
        for (const entry of session.getEntries()) {
          const id = reportedTaskId(entry);
          if (id) reported.add(id);
        }
      }
    }
    const pending = finished.filter(id => !reported.has(id)).length;
    const text = backgroundStatus(ctx.ui.theme, running, pending, performance.now(), Math.max(0, (process.stdout.columns ?? 80) - 3));
    if (text !== last) { ctx.ui.setStatus("async-bash", text); last = text; }
    const active = running.length > 0 || pending > 0;
    if (active && !timer) timer = setInterval(update, 1000).unref();
    if (!active && timer) { clearInterval(timer); timer = undefined; }
  };
  const off = manager.subscribe(update);
  process.stdout.on("resize", update);
  update();
  return () => {
    off();
    process.stdout.off("resize", update);
    if (timer) clearInterval(timer);
    ctx.ui.setStatus("async-bash", undefined);
  };
}
