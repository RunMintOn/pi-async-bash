import { TaskManager } from "../../src/tasks.ts";

const HANDOFF = 60;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function finalOf(payload) {
  const manager = new TaskManager(HANDOFF);
  const handoff = await manager.execute("owner", undefined, async execution => {
    execution.start(undefined);
    execution.log(Buffer.from(payload));
    await sleep(120);
    execution.exited(0);
    return {};
  });
  await sleep(10);
  const task = await manager.wait("owner", handoff.task_id, 5000);
  return task;
}

function summarize(name, payload, task) {
  return {
    name,
    total_bytes: Buffer.byteLength(payload),
    total_lines: payload.split("\n").length - (payload.endsWith("\n") ? 1 : 0),
    truncated: task.truncated,
    start_line: task.start_line,
    end_line: task.end_line,
    partial_line: task.partial_line,
    tail_bytes: Buffer.byteLength(task.output_tail),
    tail_starts: task.output_tail.slice(0, 12).replace(/\n/g, "\\n"),
    tail_ends: task.output_tail.slice(-12).replace(/\n/g, "\\n"),
    bad_utf8: task.output_tail.includes("\uFFFD"),
  };
}

const results = [];

// 32 行、每行 128 字节（含换行）→ 恰好 4096 字节
{
  const line = "a".repeat(127) + "\n";
  const payload = line.repeat(32);
  results.push(summarize("4096 exact, 32 lines", payload, await finalOf(payload)));
}
// 同形但首行 129 字节 → 4097 字节
{
  const payload = "a".repeat(128) + "\n" + ("a".repeat(127) + "\n").repeat(31);
  results.push(summarize("4097, 32 lines", payload, await finalOf(payload)));
}
// 40 行、每行 200 字节 → 8000 字节，触发字节上限而非行数上限
{
  const line = "b".repeat(199) + "\n";
  const payload = line.repeat(40);
  results.push(summarize("8000 bytes, 40 lines", payload, await finalOf(payload)));
}
// 41 行、每行 4 字节 → 只触发行数上限
{
  const line = "ccc\n";
  const payload = line.repeat(41);
  results.push(summarize("41 lines, 164 bytes", payload, await finalOf(payload)));
}
// 窗口起点正好落在 3 字节字符中间
{
  const payload = "aa" + "测" + "b".repeat(4094);
  results.push(summarize("window starts mid-char", payload, await finalOf(payload)));
}
// 单行 8192 字节，全为 3 字节字符
{
  const payload = "测".repeat(2730) + "\n";
  const task = await finalOf(payload);
  results.push({ ...summarize("single 8192-byte unicode line", payload, task), starts_with_bad: task.output_tail.startsWith("\uFFFD") });
}
// 只含 \r 的行
{
  const payload = "x\r".repeat(50);
  results.push(summarize("cr-only separators", payload, await finalOf(payload)));
}

// 归属隔离
{
  const manager = new TaskManager(HANDOFF);
  const handoff = await manager.execute("owner", undefined, async execution => {
    execution.start(undefined);
    await sleep(500);
    execution.exited(0);
    return {};
  });
  await sleep(10);
  let waitError = null;
  try { await manager.wait("intruder", handoff.task_id, 0); } catch (error) { waitError = String(error.message); }
  let stopError = null;
  try { await manager.stop("intruder", handoff.task_id); } catch (error) { stopError = String(error.message); }
  results.push({
    name: "owner isolation",
    wait_error: waitError,
    stop_error: stopError,
    intruder_completions: manager.takeCompletions("intruder").length,
    running_for_owner: manager.running("owner").length,
    running_for_intruder: manager.running("intruder").length,
  });
  await manager.stop("owner", handoff.task_id);
}

console.log(JSON.stringify(results, null, 1));
