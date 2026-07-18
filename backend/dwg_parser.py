"""Exact-geometry path for DWG / DXF uploads.

Why this matters: a rasterised PDF forces the vision model to *count* pixels of
identical light symbols and *estimate* areas — the main source of error. A CAD
file carries the ground truth: each fixture is a block INSERT (exact count) and
each zone is a closed polyline/hatch on a named layer (exact area). Parsing it
turns "recognition" into a lookup, so DWG uploads should be treated as
authoritative over the vision numbers when both are present.

DWG is a closed binary format; we convert DWG -> DXF first using the ODA File
Converter (free) if installed, else LibreDWG's `dwg2dxf`. DXF is parsed directly
with `ezdxf`. If no converter is available we fall back to rasterising for vision.
"""
import os
import shutil
import subprocess
import tempfile

try:
    import ezdxf
    _HAVE_EZDXF = True
except ImportError:
    _HAVE_EZDXF = False

# Block-name / layer keywords -> the same recognised categories the calc engine
# understands. Tune these to the client's CAD template once we see real DWGs.
BLOCK_KEYWORDS = {
    "PANASONIC": "downlight", "DOWNLIGHT": "downlight", "DL": "downlight",
    "TRACK": "track light", "PROFILE": "profile light", "STRIP": "strip light",
    "PENDENT": "pendent", "PENDANT": "pendent", "BATTEN": "batten",
    "SOCKET": "socket", "SWITCH": "switch", "DB": "distribution board",
    "DOOR": "door", "TV": "tv", "MIRROR": "mirror",
}
# Layer-name keyword -> (bucket, catalog-area target)
AREA_LAYER_KEYWORDS = {
    "FALSE": "false_ceiling", "FCL": "false_ceiling", "CEIL": "false_ceiling",
    "TILE": "tile", "FLOOR": "tile", "FL-": "tile",
}


def _dwg_to_dxf(dwg_path):
    """Return path to a converted DXF, or None if no converter is available."""
    outdir = tempfile.mkdtemp()
    # 1) ODA File Converter (headless). Signature varies by install; this is the
    #    common CLI form. Left configurable via ODA_CONVERTER env var.
    oda = os.environ.get("ODA_CONVERTER") or shutil.which("ODAFileConverter")
    if oda:
        subprocess.run([oda, os.path.dirname(dwg_path), outdir, "ACAD2018",
                        "DXF", "0", "1", os.path.basename(dwg_path)],
                       check=False, timeout=120)
        for f in os.listdir(outdir):
            if f.lower().endswith(".dxf"):
                return os.path.join(outdir, f)
    # 2) LibreDWG dwg2dxf
    dwg2dxf = shutil.which("dwg2dxf")
    if dwg2dxf:
        out = os.path.join(outdir, "out.dxf")
        subprocess.run([dwg2dxf, "-o", out, dwg_path], check=False, timeout=120)
        if os.path.exists(out):
            return out
    return None


def parse(filename, data):
    """Parse a DWG/DXF into a single recognised-sheet dict, or None if it can't
    be parsed here (caller then falls back to vision on a rasterised render)."""
    if not _HAVE_EZDXF:
        return None

    tmp = tempfile.NamedTemporaryFile(delete=False,
                                      suffix=os.path.splitext(filename)[1] or ".dwg")
    tmp.write(data)
    tmp.close()

    dxf_path = tmp.name
    if filename.lower().endswith(".dwg"):
        dxf_path = _dwg_to_dxf(tmp.name)
        if not dxf_path:
            return None  # no converter -> let vision handle the rasterised PDF/PNG

    try:
        doc = ezdxf.readfile(dxf_path)
    except Exception:
        return None
    msp = doc.modelspace()

    # ---- exact block-insert counts -> symbol_counts / fixtures --------------
    counts = {}
    for insert in msp.query("INSERT"):
        name = (insert.dxf.name or "").upper()
        bucket = next((v for k, v in BLOCK_KEYWORDS.items() if k in name), None)
        if bucket:
            counts[bucket] = counts.get(bucket, 0) + 1

    symbol_counts = [{"symbol": b, "description": b, "count": n}
                     for b, n in counts.items()
                     if b in ("downlight", "track light", "profile light",
                              "strip light", "pendent", "batten", "socket",
                              "switch", "distribution board")]

    # ---- exact closed-polyline areas by layer -> tile / ceiling areas -------
    area_by_bucket = {}
    for e in msp.query("LWPOLYLINE"):
        if not e.closed:
            continue
        layer = (e.dxf.layer or "").upper()
        bucket = next((v for k, v in AREA_LAYER_KEYWORDS.items() if k in layer), None)
        if not bucket:
            continue
        # ezdxf area is in drawing units^2; DDSL sheets are drawn in mm -> sq.ft.
        sqft = abs(e.get_area()) / 92903.04  # 1 sq.ft = 92903.04 mm^2
        area_by_bucket[bucket] = area_by_bucket.get(bucket, 0) + sqft

    sheet = {"sheet_type": "other", "sheet_title": filename,
             "symbol_counts": symbol_counts,
             "notes": "parsed from CAD geometry (exact counts/areas)"}
    if "false_ceiling" in area_by_bucket:
        sheet["false_ceiling_area_sqft"] = round(area_by_bucket["false_ceiling"], 1)
    # Tile areas from DWG have no product spec / wastage, so surface them as a note
    # for the operator rather than silently guessing a SKU.
    if "tile" in area_by_bucket:
        sheet["notes"] += f"; measured floor area {round(area_by_bucket['tile'],1)} sqft " \
                          f"(assign tile SKU + wastage manually or from the tiles sheet)"
    return sheet
