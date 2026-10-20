"""Read local native-bash transcripts; no execution of recorded commands or APIs.

Like threshold-analysis.py, measures transcript windows, not process runtimes.
Nested codemode calls are not reconstructed. Copies of a call are deduplicated.
"""
from collections import Counter
from datetime import datetime
from pathlib import Path
import argparse
import hashlib
import json
import math
import re


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def text(message):
    content = message.get("content", [])
    if isinstance(content, str):
        return content
    return "\n".join(c.get("text", "") for c in content if isinstance(c, dict))


def summary(rows):
    ds = sorted(r["seconds"] for r in rows)
    n = len(ds)
    return {
        "calls": n,
        "outcomes": dict(Counter(r["outcome"] for r in rows)),
        "p50_p90_p95_p99_seconds": [
            round(ds[max(0, math.ceil(p * n) - 1)], 3) if n else None
            for p in [.5, .9, .95, .99]
        ],
        "over_15": sum(d > 15 for d in ds),
        "over_60": sum(d > 60 for d in ds),
        "over_120": sum(d > 120 for d in ds),
    }


def replay(rows, threshold, conditional):
    # Observed result windows are held fixed; this does not model agent behavior.
    handing = [r for r in rows if r["seconds"] > threshold
               and not (conditional and r["explicit_timeout"])]
    blocked = [
        r["seconds"] if conditional and r["explicit_timeout"]
        else min(r["seconds"], threshold)
        for r in rows
    ]
    return {
        "window_capped_sum_seconds_not_user_wait": round(sum(blocked), 3),
        "handoffs": len(handing),
        "handoffs_finishing_within_2s": sum(r["seconds"] <= threshold + 2 for r in handing),
        "foreground_windows_over_60": sum(d > 60 for d in blocked),
        "max_foreground_window_seconds": round(max(blocked, default=0), 3),
    }


def context(entries, entry):
    before = []
    node = entry
    for _ in range(100):
        node = entries.get(node.get("parentId"))
        if not node:
            break
        msg = node.get("message", {})
        if msg.get("role") in ("user", "assistant") and text(msg).strip():
            before.append({"role": msg["role"], "text": text(msg)[-700:]})
        if msg.get("role") == "user" or len(before) >= 3:
            break
    return list(reversed(before))


parser = argparse.ArgumentParser()
parser.add_argument("--examples", action="store_true")
parser.add_argument("--rows", action="store_true",
                    help="Include hashed call identities and metrics, not commands or dialogue.")
args = parser.parse_args()
files = sorted((Path.home() / ".pi/agent/sessions").rglob("*.jsonl"))
rows = {}
counts = Counter()
examples = []
session_dates = []
tool_names = Counter()
tool_timeout_descriptions = Counter()
for file_no, path in enumerate(files):
    entries = {}
    calls = {}
    for line in path.open(errors="replace"):
        try:
            entry = json.loads(line)
        except ValueError:
            counts["malformed_json"] += 1
            continue
        if entry.get("type") == "session" and entry.get("timestamp"):
            session_dates.append(entry["timestamp"])
        if entry.get("id"):
            if args.examples:
                entries[entry["id"]] = entry
        msg = entry.get("message", {})
        if not isinstance(msg, dict):
            continue
        for definition in msg.get("toolsAdded", []):
            if definition.get("name") == "bash":
                schema = definition.get("parameters", {})
                description = schema.get("properties", {}).get("timeout", {}).get("description")
                if description:
                    tool_timeout_descriptions[description] += 1
        if msg.get("role") == "assistant" and isinstance(msg.get("content"), list):
            batch = [c for c in msg["content"] if isinstance(c, dict) and c.get("type") == "toolCall"]
            tool_names.update(c.get("name", "<missing>") for c in batch)
            for call in batch:
                if call.get("name") == "bash" and call.get("id"):
                    calls[call["id"]] = (entry, call, len(batch))
        if msg.get("role") != "toolResult" or msg.get("toolName") != "bash":
            continue
        counts["bash_results"] += 1
        match = calls.get(msg.get("toolCallId"))
        if not match:
            counts["unmatched"] += 1
            continue
        start, call, batch_size = match
        arguments = call.get("arguments") or {}
        if not isinstance(arguments, dict):
            counts["non_object_arguments"] += 1
            continue
        key = hashlib.sha256(json.dumps(
            [start.get("timestamp"), call["id"], arguments],
            sort_keys=True, ensure_ascii=False,
        ).encode()).hexdigest()
        if key in rows:
            counts["duplicate"] += 1
            continue
        try:
            seconds = stamp(entry["timestamp"]) - stamp(start["timestamp"])
        except (ValueError, KeyError, TypeError):
            counts["invalid_timestamp"] += 1
            continue
        if seconds < 0:
            counts["negative_window"] += 1
            continue
        result_text = text(msg)
        if re.search(r"Command timed out after \d+(?:\.\d+)? seconds", result_text):
            outcome = "timeout_marker"
        elif re.search(r"Still running after \d+ seconds\. Task:", result_text):
            outcome = "handoff_marker"
        elif msg.get("isError"):
            outcome = "other_tool_error"
        else:
            outcome = "no_tool_error"
        row = {
            "seconds": seconds, "batch": batch_size,
            "timeout_present": "timeout" in arguments,
            "timeout": arguments.get("timeout"), "outcome": outcome,
            "command": arguments.get("command", ""),
            "file_no": file_no, "entry_id": start.get("id"),
            "month": start["timestamp"][:7],
            "provider": start["message"].get("provider", "<missing>"),
        }
        timeout = row["timeout"]
        row["explicit_timeout"] = type(timeout) in (int, float) and timeout > 0
        row["invalid_timeout"] = timeout is not None and not row["explicit_timeout"]
        rows[key] = row
        if args.examples and batch_size == 1 and "timeout" in arguments and seconds > 15:
            examples.append({
                **row, "before": context(entries, start),
                "same_message_text": text(start["message"])[-700:],
                "result_tail": result_text[-400:],
            })
    if args.examples:
        children = {}
        for node in entries.values():
            children.setdefault(node.get("parentId"), []).append(node)
        for example in examples:
            if example["file_no"] != file_no:
                continue
            # Locate the matching result, then follow descendants on each branch.
            result = next((node for node in entries.values()
                           if node.get("message", {}).get("role") == "toolResult"
                           and node.get("message", {}).get("toolCallId")
                           == next((c["id"] for c in entries[example["entry_id"]]["message"]["content"]
                                    if c.get("type") == "toolCall" and c.get("name") == "bash"), None)), None)
            frontier = children.get(result.get("id"), []) if result else []
            for _ in range(20):
                if not frontier:
                    break
                node, *frontier = frontier
                message = node.get("message", {})
                if message.get("role") == "user":
                    continue
                if message.get("role") == "assistant" and text(message).strip():
                    example["following_assistant_text"] = text(message)[:700]
                    break
                frontier.extend(children.get(node.get("id"), []))

all_rows = list(rows.values())
single = [r for r in all_rows if r["batch"] == 1]
eligible = [r for r in single if not r["invalid_timeout"]]
# Timeout and handoff markers do not represent ordinary completion.
ordinary = [r for r in eligible if r["outcome"] not in ("timeout_marker", "handoff_marker")]
session_extra = Counter()
for row in ordinary:
    if row["explicit_timeout"]:
        session_extra[row["file_no"]] += max(0, row["seconds"] - 15)
output = {
    "files": len(files), "scan_counts": dict(counts),
    "session_header_timestamp_range": [min(session_dates), max(session_dates)] if session_dates else [],
    "tool_call_name_counts": dict(tool_names.most_common()),
    "persisted_bash_timeout_descriptions": dict(tool_timeout_descriptions),
    "bash_calls_by_provider": dict(Counter(r["provider"] for r in all_rows)),
    "single_tool_by_month": {
        month: summary([r for r in single if r["month"] == month])
        for month in sorted(set(r["month"] for r in single))
    },
    "all_native_bash": summary(all_rows),
    "single_tool": summary(single),
    "single_tool_timeout_present": summary([r for r in single if r["timeout_present"]]),
    "single_tool_timeout_absent": summary([r for r in single if not r["timeout_present"]]),
    "single_tool_valid_positive_timeout": summary([r for r in single if r["explicit_timeout"]]),
    "single_tool_null_timeout": summary([r for r in single if r["timeout_present"] and r["timeout"] is None]),
    "single_tool_invalid_timeout": summary([r for r in single if r["invalid_timeout"]]),
    "timeout_value_types": dict(Counter(type(r["timeout"]).__name__ for r in single if r["timeout_present"])),
    "explicit_timeout_values": dict(Counter(str(r["timeout"]) for r in single if r["timeout_present"]).most_common()),
    "timeout_groups": {
        str(value): summary([r for r in single if r["timeout_present"] and r["timeout"] == value])
        for value, _ in Counter(r["timeout"] for r in single if r["timeout_present"]).most_common(10)
    },
    "counterfactuals": {
        population: {
            str(t): {
                "independent": replay(rs, t, False),
                "explicit_timeout_disables_handoff": replay(rs, t, True),
            } for t in (5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60)
        } for population, rs in (("single_tool_valid_arguments_all_outcomes", eligible), ("single_tool_excluding_timeout_and_handoff", ordinary))
    },
    "ordinary_session_sensitivity": {
        "sessions": len(set(r["file_no"] for r in ordinary)),
        "sessions_with_explicit_timeout_over_15": len(set(
            r["file_no"] for r in ordinary if r["explicit_timeout"] and r["seconds"] > 15)),
        "top_5_sessions_by_extra_foreground_window_seconds": [
            {"file_no": file_no, "extra_seconds": round(total, 3)}
            for file_no, total in session_extra.most_common(5)
        ],
    },
}
if args.rows:
    output["call_records"] = [
        {"key": key, **{k: row[k] for k in (
            "seconds", "batch", "timeout_present", "timeout", "outcome",
            "explicit_timeout", "invalid_timeout", "month", "provider",
        )}}
        for key, row in rows.items()
    ]
if args.examples:
    # Longest cases plus first case per common timeout: reproducible, not random.
    chosen = sorted(examples, key=lambda r: r["seconds"], reverse=True)[:5]
    for value, _ in Counter(r["timeout"] for r in examples).most_common(8):
        group = [r for r in examples if r["timeout"] == value]
        candidate = sorted(group, key=lambda r: r["seconds"])[len(group) // 2]
        if candidate not in chosen:
            chosen.append(candidate)
    output["examples_longest_and_group_medians_not_representative"] = chosen
print(json.dumps(output, ensure_ascii=False, indent=2))
