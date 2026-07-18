"""Run real drawing sets through the vision extraction and report exact token
usage + cost per case. Usage: .venv/bin/python measure_cost.py"""
import json
import sys
import time
from pathlib import Path

import calc_engine
import extraction

PROJECTS = Path(__file__).resolve().parent.parent.parent  # job/projects

CASES = {
    "Case 1 — Shree Hari Belaganj (6 sheets)": [
        "Shree Hari Belaganj_CIVIL LAYOUT_25052026.pdf",
        "Shree Hari Belaganj_ELECTRICAL LAYOUT_25052026 (1).pdf",
        "Shree Hari Belaganj_ELEVATION1_25052026.pdf",
        "Shree Hari Belaganj_ELEVATION2 _25052026.pdf",
        "Shree Hari Belaganj_FCL_25052026.pdf",
        "Shree Hari Belaganj_TILES LAYOUT_25052026.pdf",
    ],
    "Case 2 — Chandamama (3 sheets)": [
        "Chandamama DEC SRWS 28022026_2.pdf",
        "CHANDAMAMA HAJIPUR SR RCP 26022026.pdf",
        "Chandamama Tiles 110126.pdf",
    ],
}

results = []
for name, filenames in CASES.items():
    files = [(fn, (PROJECTS / fn).read_bytes()) for fn in filenames]
    t0 = time.time()
    sheets, usage = extraction.extract(files)
    secs = time.time() - t0
    line_items, warnings = calc_engine.process(sheets)
    results.append({"case": name, "files": filenames, "seconds": round(secs, 1),
                    "usage": usage, "n_line_items": len(line_items),
                    "n_warnings": len(warnings),
                    "line_items": line_items, "warnings": warnings})
    print(f"{name}: {usage} in {secs:.0f}s, {len(line_items)} line items",
          file=sys.stderr)

Path("measured_runs.json").write_text(json.dumps(results, indent=2))
print(json.dumps([{k: r[k] for k in ("case", "seconds", "usage",
                                     "n_line_items", "n_warnings")}
                  for r in results], indent=2))
