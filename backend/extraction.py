"""Recognition half of the feature: turn drawing images into the structured
`sheets` data the calc engine consumes.

Uses Claude Opus 4.8 vision. The model is asked ONLY to read what is on the
sheet — legend/schedule tables, symbol counts, areas, wall finishes. It does no
arithmetic; calc_engine.py does that. Output is constrained to a JSON schema.
"""
import base64
import io
import os

import anthropic
import fitz  # PyMuPDF

MODEL = "claude-opus-4-8"
RENDER_DPI = 200  # architectural sheets are dense; 200 DPI keeps small legend text legible

SYSTEM = """You read Indian architectural fit-out drawings for a two-wheeler
dealership (Hero showroom fit-out by DDSL). You are a careful quantity surveyor.

Extract ONLY what is printed on the sheet. Do NOT calculate, multiply, or add
anything — report raw values exactly as drawn (areas, counts, dimensions,
product names). Downstream code does all arithmetic.

Read every legend/schedule table completely:
- TILES sheet: the tile legend maps codes (FL-01, WL-02 ...) to a product spec
  (e.g. "Johnson Endura (Grey 12mm) 300x300") and an Area (sqft) per zone
  (Workshop / Showroom) usually with "+10% Wastage". Report area numbers exactly
  and the wastage percent.
- CIVIL sheet: the DOOR LEGEND maps a type (TG-1, D-1 ...) to width + spec. Also
  count how many of each door/partition symbol appear on the plan.
- ELECTRICAL sheet: the symbol legend lists each fixture/point; COUNT how many of
  each symbol appear on the plan. Read the Area Chart (Showroom/Workshop/etc sqft).
- FCL / RCP: report false-ceiling area if given; count ceiling light fixtures.
- ELEVATION: report wall finishes (paint name), and count mirrors, TV cutouts,
  tracks, glass panels, signage/logos.
- FURNITURE/LAYOUT: count furniture items (reception table, waiting bench, chairs,
  podium, discussion table ...).

If a value is not present on the sheet, use null / omit it. Never guess a number."""

# JSON schema the model must return.
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "sheets": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "sheet_type": {"type": "string",
                                   "enum": ["tiles", "electrical", "civil", "fcl",
                                            "rcp", "elevation", "furniture", "other"]},
                    "sheet_title": {"type": "string"},
                    "project_name": {"type": "string"},
                    "tile_legend": {"type": "array", "items": {
                        "type": "object", "additionalProperties": False,
                        "properties": {
                            "code": {"type": "string"},
                            "location": {"type": "string"},
                            "product_spec": {"type": "string"},
                            "area_workshop_sqft": {"type": ["number", "null"]},
                            "area_showroom_sqft": {"type": ["number", "null"]},
                            "wastage_pct": {"type": ["number", "null"]},
                        }, "required": ["product_spec"]}},
                    "door_schedule": {"type": "array", "items": {
                        "type": "object", "additionalProperties": False,
                        "properties": {
                            "type": {"type": "string"},
                            "width_mm": {"type": ["number", "null"]},
                            "spec": {"type": "string"},
                            "count": {"type": ["integer", "null"]},
                        }, "required": ["type"]}},
                    "symbol_counts": {"type": "array", "items": {
                        "type": "object", "additionalProperties": False,
                        "properties": {
                            "symbol": {"type": "string"},
                            "description": {"type": "string"},
                            "count": {"type": "integer"},
                        }, "required": ["description", "count"]}},
                    "fixtures": {"type": "array", "items": {
                        "type": "object", "additionalProperties": False,
                        "properties": {
                            "name": {"type": "string"},
                            "count": {"type": "integer"},
                        }, "required": ["name", "count"]}},
                    "area_chart": {"type": ["object", "null"], "additionalProperties": True},
                    "false_ceiling_area_sqft": {"type": ["number", "null"]},
                    "paint_area_sqft": {"type": ["number", "null"]},
                    "glass_partition_sqft": {"type": ["number", "null"]},
                    "wall_finishes": {"type": "array", "items": {"type": "string"}},
                    "notes": {"type": "string"},
                },
                "required": ["sheet_type"],
            },
        }
    },
    "required": ["sheets"],
}


def _pdf_to_png_pages(data):
    """Render each PDF page to PNG bytes."""
    pages = []
    doc = fitz.open(stream=data, filetype="pdf")
    mat = fitz.Matrix(RENDER_DPI / 72, RENDER_DPI / 72)
    for page in doc:
        pages.append(page.get_pixmap(matrix=mat).tobytes("png"))
    doc.close()
    return pages


def file_to_image_blocks(filename, data):
    """Turn an uploaded file into Anthropic image content blocks.
    PDFs are rasterised page-by-page; images are passed through."""
    blocks = []
    lower = filename.lower()
    if lower.endswith(".pdf"):
        pngs = _pdf_to_png_pages(data)
        media = "image/png"
        raws = pngs
    else:
        media = "image/png" if lower.endswith(".png") else "image/jpeg"
        raws = [data]
    for raw in raws:
        blocks.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media,
                       "data": base64.standard_b64encode(raw).decode()},
        })
    return blocks


def extract(files):
    """files: list of (filename, bytes). Returns the parsed `sheets` list.
    Sends all sheets in one request so cross-sheet context (project name, zones)
    is available to the model."""
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY / ant profile

    content = [{"type": "text",
                "text": "Here are the drawing sheets for one project. "
                        "Extract each sheet into the schema."}]
    for name, data in files:
        content.append({"type": "text", "text": f"--- FILE: {name} ---"})
        content.extend(file_to_image_blocks(name, data))

    resp = client.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": content}],
    )
    import json
    text = next(b.text for b in resp.content if b.type == "text")
    # usage: exact billed tokens for this request (cost transparency per project)
    usage = {"model": resp.model,
             "input_tokens": resp.usage.input_tokens,
             "output_tokens": resp.usage.output_tokens}
    return json.loads(text)["sheets"], usage
