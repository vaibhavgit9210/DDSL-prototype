"""DDSL drawing-analysis API.

POST /analyze  (multipart, one or more files: PDF / PNG / JPG / DWG / DXF)
  -> { line_items: [...], warnings: [...], sheets: [...] }

Flow:
  1. DWG/DXF -> exact geometry via dwg_parser (authoritative when it parses).
  2. Everything else (and DWGs with no converter) -> Claude Opus 4.8 vision.
  3. Recognised sheets -> deterministic calc_engine -> catalog line items.

The line items match the shape the frontend auto-fill expects
(product_id == catalog changeQty_id, quantity), plus a `calculation` string per
item for the review panel.
"""
import os

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import calc_engine
import dwg_parser
import extraction

app = FastAPI(title="DDSL Drawing Analysis")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

DWG_EXT = (".dwg", ".dxf")


@app.get("/health")
def health():
    return {"ok": True, "model": extraction.MODEL,
            "dwg_support": dwg_parser._HAVE_EZDXF}


@app.post("/analyze")
async def analyze(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(400, "no files uploaded")

    cad_sheets = []          # exact-geometry sheets from DWG/DXF
    vision_files = []        # (name, bytes) to send to the vision model

    for f in files:
        data = await f.read()
        name = f.filename or "upload"
        if name.lower().endswith(DWG_EXT):
            parsed = dwg_parser.parse(name, data)
            if parsed is not None:
                cad_sheets.append(parsed)
                continue
            # DWG but no converter available -> can't rasterise a binary DWG for
            # vision either; tell the operator instead of silently dropping it.
            raise HTTPException(
                422,
                f"{name}: DWG received but no DWG->DXF converter is installed on "
                f"the server (set ODA_CONVERTER or install dwg2dxf). Upload the "
                f"matching PDF, or a DXF export, for this sheet.")
        vision_files.append((name, data))

    sheets = list(cad_sheets)
    usage = None
    if vision_files:
        try:
            extracted, usage = extraction.extract(vision_files)
            sheets.extend(extracted)
        except Exception as e:  # surface model/auth errors clearly to the UI
            raise HTTPException(502, f"vision extraction failed: {e}")

    line_items, warnings = calc_engine.process(sheets)

    # Append per-request usage to usage.jsonl so cost per project is auditable.
    if usage is not None:
        import datetime
        import json as _json
        with open(os.path.join(os.path.dirname(__file__), "usage.jsonl"), "a") as fh:
            fh.write(_json.dumps({
                "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "files": [f.filename for f in files], **usage}) + "\n")

    return {"line_items": line_items, "warnings": warnings, "sheets": sheets,
            "usage": usage}
