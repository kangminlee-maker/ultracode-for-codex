#!/usr/bin/env python3
"""Rank the hardest real code findings and print them for pattern extraction.
Difficulty = severity weight + causal depth + cross-file bonus. Capped per
project for diversity."""
import json, os, sys
from collections import defaultdict

SRC = os.path.join(os.path.dirname(__file__), "findings.jsonl")
SEV_W = {"critical": 5, "blocker": 5, "high": 3, "medium": 1, "low": 0, "info": 0, None: 0}
PER_PROJECT_CAP = int(sys.argv[1]) if len(sys.argv) > 1 else 4
TOTAL = int(sys.argv[2]) if len(sys.argv) > 2 else 55


def trunc(s, n):
    s = (s or "").replace("\n", " ").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


rows = [json.loads(l) for l in open(SRC) if l.strip()]
code = [r for r in rows if r["code_evidence"]]
for r in code:
    r["score"] = SEV_W.get(r["severity"], 0) + r["causal_step_count"] + (2 if r["cross_code_file"] else 0)
code.sort(key=lambda r: (-r["score"], -r["causal_step_count"]))

picked, per = [], defaultdict(int)
for r in code:
    if per[r["project"]] >= PER_PROJECT_CAP:
        continue
    per[r["project"]] += 1
    picked.append(r)
    if len(picked) >= TOTAL:
        break

for i, r in enumerate(picked, 1):
    print(f"\n[{i}] {r['project']}  sev={r['severity']} causal={r['causal_step_count']} files={r['code_file_count']} lens={r['lens_id']}")
    print(f"    files: {', '.join(r['code_files'][:4])}")
    print(f"    claim: {trunc(r['claim'], 240)}")
    print(f"    fail : {trunc(r['failure_condition'], 240)}")
    print(f"    root : {trunc(r['root_cause'], 240)}")
