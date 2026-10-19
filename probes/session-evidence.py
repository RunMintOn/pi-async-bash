"""Read-only representative sampling. Does not export command bodies or outputs."""
from pathlib import Path
from datetime import datetime
import json
import re

root = Path.home() / ".pi/agent/sessions"
files = sorted(root.glob("--*--/*.jsonl"))
selected = {}

def seconds(a, b):
    return (datetime.fromisoformat(b.replace("Z", "+00:00")) -
            datetime.fromisoformat(a.replace("Z", "+00:00"))).total_seconds()

for path in files:
    calls = {}
    parallel = None
    parallel_results = []
    for line_no, line in enumerate(path.open(errors="replace"), 1):
        try:
            entry = json.loads(line)
        except (ValueError, TypeError):
            continue
        message = entry.get("message", {})
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if message.get("role") == "assistant" and isinstance(content, list):
            bash_calls = [c for c in content if c.get("type") == "toolCall" and c.get("name") == "bash"]
            for call in bash_calls:
                calls[call["id"]] = (line_no, entry["timestamp"], message.get("timestamp"), call.get("arguments", {}))
            if len(bash_calls) > 1 and "parallel" not in selected and parallel is None:
                parallel = {
                    "file": str(path), "assistant_line": line_no,
                    "entry_timestamp": entry["timestamp"],
                    "message_timestamp": message.get("timestamp"),
                    "call_ids": [c["id"] for c in bash_calls],
                }
        if message.get("role") != "toolResult" or message.get("toolCallId") not in calls:
            continue
        call_id = message["toolCallId"]
        if parallel and call_id in parallel["call_ids"]:
            parallel_results.append({"line": line_no, "timestamp": entry["timestamp"]})
            if len(parallel_results) == len(parallel["call_ids"]):
                selected["parallel"] = {**parallel, "results": parallel_results}
        call_line, timestamp, message_timestamp, args = calls[call_id]
        command = args.get("command", "")
        if not isinstance(command, str):
            continue
        elapsed = seconds(timestamp, entry["timestamp"])
        categories = []
        if elapsed > 60:
            categories.append("long")
        if command.lstrip().startswith("sleep ") and ("tail " in command or "grep " in command):
            categories.append("sleep_poll")
        if "nohup " in command or command.rstrip().endswith("&"):
            categories.append("manual_background")
        for category in categories:
            if category in selected:
                continue
            texts = [c.get("text", "") for c in message.get("content", []) if c.get("type") == "text"]
            sleep_match = re.match(r"\s*sleep\s+(\d+)", command)
            selected[category] = {
                "file": str(path), "call_line": call_line, "result_line": line_no,
                "assistant_entry_timestamp": timestamp,
                "assistant_message_timestamp": message_timestamp,
                "result_entry_timestamp": entry["timestamp"], "entry_wall_seconds": elapsed,
                "timeout": args.get("timeout"), "output_chars": sum(map(len, texts)),
                "isError": message.get("isError"),
                "leading_sleep_seconds": int(sleep_match[1]) if sleep_match else None,
            }
        if len(selected) == 4:
            break
    if len(selected) == 4:
        break

print(json.dumps({
    "available_session_files": len(files),
    "note": "Representative samples, not an aggregate recomputation.",
    "samples": selected,
}, ensure_ascii=False, indent=2))
