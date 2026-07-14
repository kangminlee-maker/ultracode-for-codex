#!/usr/bin/env python3
"""Harvest all onto review findings into a flat dataset + distributions.

Walks every .onto/review/*/finding-ledger.yaml under the given roots, extracts
per-finding fields, and derives difficulty signals:
  - causal_step_count : number of causal_path.steps (reasoning-depth proxy)
  - evidence_ref_count: number of evidence_refs
  - distinct_files    : distinct file paths referenced in evidence
  - cross_file        : evidence spans >1 distinct file
  - code_evidence     : evidence references a code file (.ts/.js/.mjs/.py/.tsx ...)
Writes findings.jsonl (one row per finding) and prints distributions.
"""
import json
import os
import re
import sys
import glob

try:
    import yaml
except ImportError:
    sys.exit("pyyaml required")

ROOTS = sys.argv[1:] or [os.path.expanduser("~/Documents"), os.path.expanduser("~/cowork")]
OUT = os.path.join(os.path.dirname(__file__), "findings.jsonl")

CODE_EXT = re.compile(r"\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|cc|cpp|h|hpp|sql)(:|$|#|,)")
FILE_IN_REF = re.compile(r"([\w./\-]+\.\w+)")


def find_ledgers(roots):
    # Fast path: a precomputed newline list of ledger paths (from `find`), which
    # avoids python glob descending into node_modules.
    paths_file = os.path.join(os.path.dirname(__file__), "ledger-paths.txt")
    if os.path.exists(paths_file):
        with open(paths_file) as fh:
            for line in fh:
                p = line.strip()
                if p and "/node_modules/" not in p:
                    yield p
        return
    for root in roots:
        pattern = os.path.join(root, "**", ".onto", "review", "*", "finding-ledger.yaml")
        for path in glob.iglob(pattern, recursive=True):
            if "/node_modules/" in path:
                continue
            yield path


def project_of(path):
    # .../<project>/.onto/review/<session>/finding-ledger.yaml
    marker = "/.onto/review/"
    i = path.find(marker)
    return os.path.basename(path[:i]) if i > 0 else "?"


def distinct_files(evidence_refs):
    files = set()
    for ref in evidence_refs or []:
        for m in FILE_IN_REF.findall(str(ref)):
            files.add(m)
    return files


def distinct_code_files(evidence_refs):
    """Real target code files only: has a code extension and is NOT an internal
    .onto review self-reference (those contaminate the cross-file signal)."""
    files = set()
    for ref in evidence_refs or []:
        s = str(ref)
        if s.startswith(".onto/") or "/.onto/" in s:
            continue
        if not CODE_EXT.search(s):
            continue
        for m in FILE_IN_REF.findall(s):
            if CODE_EXT.search(m) or CODE_EXT.search(m + ":"):
                files.add(m)
    return files


def has_code(evidence_refs):
    return any(CODE_EXT.search(str(ref)) for ref in (evidence_refs or []))


rows = []
n_files = 0
n_bad = 0
for path in find_ledgers(ROOTS):
    n_files += 1
    try:
        with open(path, "r") as fh:
            doc = yaml.safe_load(fh)
    except Exception:
        n_bad += 1
        continue
    if not isinstance(doc, dict):
        continue
    project = project_of(path)
    for f in doc.get("findings", []) or []:
        if not isinstance(f, dict):
            continue
        ev = f.get("evidence_refs") or []
        cp = f.get("causal_path") or {}
        steps = cp.get("steps") or [] if isinstance(cp, dict) else []
        files = distinct_files(ev)
        code_files = distinct_code_files(ev)
        rows.append({
            "project": project,
            "session": doc.get("session_id"),
            "finding_id": f.get("finding_id"),
            "lens_id": f.get("lens_id"),
            "severity": (f.get("severity") or "").lower() or None,
            "target": f.get("target"),
            "claim": f.get("claim"),
            "failure_condition": f.get("failure_condition"),
            "impact": f.get("impact"),
            "proposed_action": f.get("proposed_action"),
            "causal_step_count": len(steps),
            "root_cause": (cp.get("root_cause_candidate") if isinstance(cp, dict) else None),
            "evidence_ref_count": len(ev),
            "distinct_file_count": len(files),
            "code_files": sorted(code_files),
            "code_file_count": len(code_files),
            "cross_code_file": len(code_files) > 1,
            "code_evidence": has_code(ev),
        })

with open(OUT, "w") as fh:
    for r in rows:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")


def dist(key, rows, top=None):
    from collections import Counter
    c = Counter(r[key] for r in rows)
    items = c.most_common(top)
    return items


print(f"ledgers scanned: {n_files}  (unparseable: {n_bad})")
print(f"findings harvested: {len(rows)}  -> {OUT}\n")

print("=== by severity ===")
for k, v in dist("severity", rows):
    print(f"  {str(k):10} {v}")

print("\n=== by lens_id ===")
for k, v in dist("lens_id", rows):
    print(f"  {str(k):16} {v}")

code = [r for r in rows if r["code_evidence"]]
print(f"\n=== code-evidence findings: {len(code)} / {len(rows)} ===")

print("\n=== causal_step_count distribution (depth proxy, code findings) ===")
from collections import Counter
cc = Counter(r["causal_step_count"] for r in code)
for k in sorted(cc):
    print(f"  steps={k:2}  {cc[k]}")

print("\n=== real cross-CODE-file (code findings, .onto self-refs excluded) ===")
cf = Counter(r["cross_code_file"] for r in code)
for k, v in cf.items():
    print(f"  cross_code_file={k}: {v}")
print("  code_file_count distribution:")
cfc = Counter(r["code_file_count"] for r in code)
for k in sorted(cfc):
    print(f"    files={k}: {cfc[k]}")

# HARD subset: code evidence AND (high/critical severity OR deep causal OR real cross-file)
hard = [r for r in code if (r["severity"] in ("high", "critical", "blocker")
                            or r["causal_step_count"] >= 4
                            or r["cross_code_file"])]
print(f"\n=== HARD code subset (high-sev OR causal>=3 OR cross-file): {len(hard)} ===")
print("  by project:")
for k, v in dist("project", hard, 20):
    print(f"    {str(k):40} {v}")
