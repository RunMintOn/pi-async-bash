"""Compare handoff thresholds using transcript windows, not process runtimes.

Read-only source scan. Output contains aggregates only; repeated branch copies
of the same call are counted once. No command bodies or session paths exported.
"""
from collections import Counter
from datetime import datetime
from pathlib import Path
import hashlib
import json
import math


def timestamp(value):
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    return None


def summary(rows):
    durations = sorted(row["seconds"] for row in rows)
    total = sum(durations)
    n = len(durations)
    return {
        "calls": n,
        "window_seconds_sum_not_user_wait": round(total, 3),
        "quantiles_seconds": {
            str(p): round(durations[max(0, math.ceil(p * n) - 1)], 3) if n else None
            for p in [0.5, 0.9, 0.95, 0.99]
        },
        "thresholds": [
            {
                "threshold_seconds": t,
                "handoff_calls": sum(d > t for d in durations),
                "handoff_percent": round(100 * sum(d > t for d in durations) / n, 3) if n else 0,
                "remaining_over_threshold_seconds_sum": round(sum(max(0, d - t) for d in durations), 3),
                "finish_within_two_seconds_after_handoff": sum(t < d <= t + 2 for d in durations),
                "finish_within_two_seconds_percent_of_handoffs": round(
                    100 * sum(t < d <= t + 2 for d in durations) / sum(d > t for d in durations), 3
                ) if any(d > t for d in durations) else 0,
            }
            for t in [5, 10, 15, 30]
        ],
    }


root = Path.home() / ".pi/agent/sessions"
files = sorted(root.glob("--*--/*.jsonl"))
unique = {}
counts = Counter()

for path in files:
    calls = {}
    with path.open(errors="replace") as source:
        for line in source:
            try:
                entry = json.loads(line)
            except ValueError:
                counts["malformed_json"] += 1
                continue
            message = entry.get("message", {})
            if not isinstance(message, dict):
                continue
            if message.get("role") == "assistant" and isinstance(message.get("content"), list):
                batch = [c for c in message["content"] if isinstance(c, dict) and c.get("type") == "toolCall"]
                for call in batch:
                    if call.get("name") != "bash" or not call.get("id"):
                        continue
                    started = timestamp(entry.get("timestamp"))
                    identity = json.dumps(
                        [entry.get("timestamp"), call["id"], call.get("arguments")],
                        sort_keys=True, ensure_ascii=False,
                    )
                    calls[call["id"]] = (started, hashlib.sha256(identity.encode()).hexdigest(), len(batch))
            if message.get("role") != "toolResult" or message.get("toolName") != "bash":
                continue
            counts["bash_result_entries"] += 1
            call = calls.pop(message.get("toolCallId"), None)
            if call is None:
                counts["unmatched_results"] += 1
                continue
            started, key, batch_size = call
            ended = timestamp(entry.get("timestamp"))
            if started is None or ended is None or ended < started:
                counts["invalid_timestamps"] += 1
                continue
            seconds = ended - started
            if key in unique:
                counts["duplicate_call_copies"] += 1
                if abs(unique[key]["seconds"] - seconds) > 0.001:
                    counts["duplicates_with_different_windows"] += 1
                continue
            unique[key] = {
                "seconds": seconds,
                "batch_size": batch_size,
                "error": bool(message.get("isError")),
            }

rows = list(unique.values())
print(json.dumps({
    "source": "~/.pi/agent/sessions/--*--/*.jsonl",
    "files": len(files),
    "scan_counts": dict(counts),
    "method": "assistant entry timestamp to matching toolResult entry timestamp; nearest-rank quantiles",
    "limitations": [
        "Transcript windows are not measured process runtimes.",
        "Sibling results can share timestamps; their durations are not independent.",
        "Sums across calls are not wall-clock user waiting time or a forecast of time saved.",
        "The single-tool subset excludes every assistant batch with any sibling tool, not only sibling bash calls.",
        "Historical sleep/polling calls remain included; no command classification or external API calls.",
    ],
    "all_unique_bash": summary(rows),
    "single_tool_batch_only": summary([r for r in rows if r["batch_size"] == 1]),
    "multi_tool_batch_only": summary([r for r in rows if r["batch_size"] > 1]),
    "single_tool_success_only": summary([r for r in rows if r["batch_size"] == 1 and not r["error"]]),
}, ensure_ascii=False, indent=2))
