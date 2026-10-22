import assert from "node:assert/strict";
import test from "node:test";
import { harness, node } from "./support.mjs";

test("the native Footer follows handed-off sessions, updates once after reload and clears on completion", { timeout: 15000 }, async (t) => {
  const updates = [];
  const statuses = new Map();
  const h = await harness({}, [], { binding: { mode: "tui", uiContext: {
    setStatus(key, value) {
      updates.push([key, value]);
      if (value === undefined) statuses.delete(key);
      else statuses.set(key, value);
    },
    notify() {},
  } } });
  try {
    const first = await h.call("footer process", {
      command: node('process.stdout.write("READY\\n"); process.stdin.once("data", () => process.exit(0));'),
      yield_time_ms: 250,
    });
    assert.equal(statuses.get("async-bash"), "BG 1 · 0s");
    const file = h.runtime.session.sessionFile;
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    await h.runtime.session.reload();
    await h.runtime.session.reload();
    const before = updates.length;
    t.mock.timers.tick(1000);
    assert.equal(statuses.get("async-bash"), "BG 1 · 1s");
    assert.equal(updates.length, before + 1, "reload left duplicate Footer updates");
    t.mock.timers.reset();
    await h.runtime.newSession();
    assert.equal(statuses.get("async-bash"), undefined);
    await h.runtime.switchSession(file);
    assert.match(statuses.get("async-bash"), /^BG 1/);
    const final = await h.call("finish footer process", { session_id: first.details.session_id, chars: "done\n" }, "write_stdin");
    assert.equal(final.details.exit_code, 0);
    assert.equal(statuses.get("async-bash"), undefined);
  } finally { t.mock.timers.reset(); await h.close(); }
});
