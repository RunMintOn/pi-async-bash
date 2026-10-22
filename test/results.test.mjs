import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harness, node } from "./support.mjs";

test("both tools expose per-read truncation and the full raw log, not historical truncation", { timeout: 15000 }, async () => {
  const h = await harness();
  try {
    const first = await h.call("line truncation", {
      command: "exec " + node(`
        process.stdout.write("LINE\\n".repeat(2500));
        process.stdin.on("data", data => {
          if (data.toString() === "large") process.stdout.write("中".repeat(50000) + "\\nTAIL\\n");
          else { process.stdout.write("DONE\\n"); process.exit(7); }
        });
      `),
      yield_time_ms: 250,
    });
    assert.equal(first.details.truncated, true);
    assert.equal(readFileSync(first.details.full_output_path, "utf8"), "LINE\n".repeat(2500));
    assert(first.details.output.includes(first.details.full_output_path));

    const large = await h.call("byte truncation", {
      session_id: first.details.session_id, chars: "large", yield_time_ms: 500,
    }, "write_stdin");
    assert.equal(large.details.truncated, true);
    assert.equal(large.details.full_output_path, first.details.full_output_path);
    assert(!large.details.output.includes("\uFFFD"));
    assert.match(large.details.output, /TAIL/);
    assert.equal(readFileSync(large.details.full_output_path, "utf8"),
      "LINE\n".repeat(2500) + "中".repeat(50000) + "\nTAIL\n");

    const final = await h.call("untruncated finish", {
      session_id: first.details.session_id, chars: "finish",
    }, "write_stdin");
    const { wall_time_seconds, ...data } = final.details;
    assert.deepEqual(data, { output: "DONE\n", truncated: false, exit_code: 7 });
    assert.equal(final.isError, true);
    for (const result of [first, large, final]) {
      assert(Number.isFinite(result.details.wall_time_seconds) && result.details.wall_time_seconds >= 0);
    }
    const again = await h.call("empty finished read", { session_id: first.details.session_id }, "write_stdin");
    assert.equal(again.details.output, "");
    assert.equal(again.details.truncated, false);
    assert.equal(again.details.full_output_path, undefined);
  } finally { await h.close(); }
});
