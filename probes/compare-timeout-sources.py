"""Compare anonymized --rows snapshots produced by timeout-analysis.py."""
import argparse
from collections import Counter
import json

parser = argparse.ArgumentParser()
parser.add_argument("snapshots", nargs="+")
args = parser.parse_args()
sources = []
combined = {}
duplicates = 0
for path in args.snapshots:
    with open(path) as source:
        snapshot = json.load(source)
    records = snapshot["call_records"]
    for row in records:
        if row["key"] in combined:
            duplicates += 1
            old = combined[row["key"]]
            if abs(old["seconds"] - row["seconds"]) > .001:
                raise ValueError("Duplicate call has different result windows")
        else:
            combined[row["key"]] = row
    sources.append((path, records))
sources.append(("combined_deduplicated", list(combined.values())))
result = {"cross_source_duplicate_copies": duplicates, "sources": {}}
for name, records in sources:
    single = [r for r in records if r["batch"] == 1
              and r["provider"] != "mock" and not r["invalid_timeout"]]
    ordinary = [r for r in single if r["outcome"] not in ("timeout_marker", "handoff_marker")]
    n = len(ordinary)
    result["sources"][name] = {
        "comparison_calls": n,
        "before_outcome_exclusion": len(single),
        "explicit_timeout_calls": sum(r["explicit_timeout"] for r in single),
        "top_timeout_values": Counter(
            r["timeout"] for r in single if r["explicit_timeout"]).most_common(10),
        "thresholds": [
            {
                "seconds": t,
                "within_percent": round(100 * sum(r["seconds"] <= t for r in ordinary) / n, 3) if n else None,
                "handoffs": sum(r["seconds"] > t for r in ordinary),
            } for t in (5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60)
        ],
        "months": {
            month: {
                "calls": len(group := [r for r in ordinary if r["month"] == month]),
                "within_30_percent": round(100 * sum(r["seconds"] <= 30 for r in group) / len(group), 3),
                "within_60_percent": round(100 * sum(r["seconds"] <= 60 for r in group) / len(group), 3),
            } for month in sorted(set(r["month"] for r in ordinary))
        },
    }
print(json.dumps(result, ensure_ascii=False, indent=2))
