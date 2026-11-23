import { existsSync } from "node:fs";
import { TaskManager } from "../../src/tasks.ts";

const HANDOFF = 60;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeRun(payload, { delay = 150, timedOut = false } = {}) {
  return async execution => {
    execution.start(undefined);
    if (payload.length) execution.log(Buffer.from(payload));
    await sleep(delay);
    if (timedOut) execution.timedOut();
    execution.exited(0);
    return { content: [{ type: "text", text: "native" }] };
  };
}

async function snapshot(manager, owner, payload, options = {}) {
  const handoff = await manager.execute(owner, undefined, fakeRun(payload, options));
  const id = handoff.task_id;
  await sleep(10);
  const running = await manager.wait(owner, id, 0);
  const final = await manager.wait(owner, id, 5000);
  return { id, running, final };
}

const cases = [];
const add = (name, value) => cases.push([name, value]);

const one = "a".repeat(100);

// 行数与字节上限的精确边界
{
  const fortyLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join("");
  const r = await snapshot(new TaskManager(HANDOFF), "o", fortyLines);
  add("40 lines exact", { bytes: Buffer.byteLength(fortyLines), ...pick(r.final) });
}
{
  const fortyOne = Array.from({ length: 41 }, (_, i) => `line ${i + 1}\n`).join("");
  const r = await snapshot(new TaskManager(HANDOFF), "o", fortyOne);
  add("41 lines", { bytes: Buffer.byteLength(fortyOne), ...pick(r.final) });
}
{
  const exact = one.repeat(40) + "\n".repeat(39) + "\n";
  const r = await snapshot(new TaskManager(HANDOFF), "o", exact);
  add("4096 bytes exact", { bytes: Buffer.byteLength(exact), ...pick(r.final) });
}
{
  const over = one.repeat(40) + "\n".repeat(39) + "b\n";
  const r = await snapshot(new TaskManager(HANDOFF), "o", over);
  add("4097 bytes", { bytes: Buffer.byteLength(over), ...pick(r.final) });
}

// 多字节与非法 UTF-8
{
  const payload = "x".repeat(4095) + "测测\n";
  const r = await snapshot(new TaskManager(HANDOFF), "o", payload);
  add("multibyte straddle", { ...pick(r.final), bad_utf8: r.final.output_tail.includes("\uFFFD"), head: r.final.output_tail.slice(0, 4) });
}
{
  const payload = "测".repeat(2000) + "\n";
  const r = await snapshot(new TaskManager(HANDOFF), "o", payload);
  add("3-byte chars only", { ...pick(r.final), bad_utf8: r.final.output_tail.includes("\uFFFD") });
}
{
  const manager = new TaskManager(HANDOFF);
  const handoff = await manager.execute("o", undefined, async execution => {
    execution.start(undefined);
    execution.log(Buffer.from([0xff, 0xfe, 0x41, 0x0a]));
    await sleep(150);
    execution.exited(0);
    return {};
  });
  const final = await manager.wait("o", handoff.task_id, 5000);
  add("invalid utf8", { ...pick(final), bad_utf8: final.output_tail.includes("\uFFFD") });
}

// 结尾、空行、CRLF
{
  const r = await snapshot(new TaskManager(HANDOFF), "o", "a\nb");
  add("no trailing newline", pick(r.final));
}
{
  const r = await snapshot(new TaskManager(HANDOFF), "o", "\n".repeat(100));
  add("100 empty lines", pick(r.final));
}
{
  const r = await snapshot(new TaskManager(HANDOFF), "o", "a\r\nb\r\n");
  add("crlf", { ...pick(r.final), has_cr: r.final.output_tail.includes("\r") });
}
{
  const r = await snapshot(new TaskManager(HANDOFF), "o", "");
  add("empty log", pick(r.final));
}

// 大日志与时间
{
  const payload = "x".repeat(200) + "\n";
  const big = payload.repeat(100_000);
  const started = performance.now();
  const r = await snapshot(new TaskManager(HANDOFF), "o", big, { delay: 800 });
  const previewMs = performance.now() - started;
  add("20MB / 100k lines", { bytes: Buffer.byteLength(big), ...pick(r.final), totalMs: Math.round(previewMs) });
}

// running 快照与终态的状态文案
{
  const manager = new TaskManager(HANDOFF);
  const handoff = await manager.execute("o", undefined, async execution => {
    execution.start(undefined);
    for (let i = 1; i <= 100; i++) execution.log(Buffer.from(`progress ${i}\n`));
    await sleep(400);
    execution.exited(0);
    return {};
  });
  await sleep(20);
  const running = await manager.wait("o", handoff.task_id, 0);
  await sleep(80);
  const running2 = await manager.wait("o", handoff.task_id, 0);
  const final = await manager.wait("o", handoff.task_id, 5000);
  add("running snapshot", { first: pick(running), second: pick(running2), final: pick(final) });
}

// 超时与停止的终态文案
{
  const r = await snapshot(new TaskManager(HANDOFF), "o", "", { timedOut: true });
  add("timed_out wording", pick(r.final));
}
{
  const manager = new TaskManager(HANDOFF);
  const handoff = await manager.execute("o", undefined, async execution => {
    execution.start(undefined);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      execution.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    });
    return {};
  });
  const stopped = await manager.stop("o", handoff.task_id);
  const after = await manager.wait("o", handoff.task_id, 0);
  add("stopped wording", { returned: stopped, ...pick(after) });
  await manager.stop("o", handoff.task_id);
  add("stop twice ok", true);
}

// 等待提前返回、等待取消、未知任务
{
  const manager = new TaskManager(HANDOFF);
  const handoff = await manager.execute("o", undefined, async execution => {
    execution.start(undefined);
    await sleep(600);
    execution.exited(0);
    return {};
  });
  const started = performance.now();
  const waited = await manager.wait("o", handoff.task_id, 30);
  add("wait returns early", { elapsedMs: Math.round(performance.now() - started), status: waited.status });
}
{
  const manager = new TaskManager(HANDOFF);
  const handoff = await manager.execute("o", undefined, async execution => {
    execution.start(undefined);
    await sleep(3000);
    return {};
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("caller cancelled")), 50);
  try {
    await manager.wait("o", handoff.task_id, 30, controller.signal);
    add("wait cancelled", "resolved");
  } catch (error) {
    add("wait cancelled", String(error.message ?? error));
  }
  await manager.stop("o", handoff.task_id);
}
{
  const manager = new TaskManager(HANDOFF);
  try { await manager.wait("o", "abcdef", 0); } catch (error) { add("unknown id", String(error.message)); }
}

// 并发与投递
{
  const manager = new TaskManager(HANDOFF);
  const handoffs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    manager.execute("o", undefined, fakeRun(`task ${i}\n`, { delay: 200 }))));
  const ids = new Set(handoffs.map(h => h.task_id));
  add("10 concurrent ids", { unique: ids.size, len6hex: [...ids].every(id => /^[0-9a-f]{6}$/.test(id)) });
  await sleep(500);
  const batch = manager.takeCompletions("o");
  const again = manager.takeCompletions("o");
  manager.markDelivered("o", batch[0].task_id);
  add("delivery dedup", { first: batch.length, second: again.length });
  await manager.shutdown();
  add("shutdown cleans logs", { dirGone: !existsSync(batch[0].log_path) });
}

function pick(task) {
  return {
    status: task.status,
    truncated: task.truncated,
    start_line: task.start_line,
    end_line: task.end_line,
    partial_line: task.partial_line,
    tail_bytes: Buffer.byteLength(task.output_tail),
  };
}

console.log(JSON.stringify(Object.fromEntries(cases), null, 1));
