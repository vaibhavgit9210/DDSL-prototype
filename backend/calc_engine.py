"""Deterministic calculation engine — the "processing" half of the feature.

Principle: the LLM (or DWG parser) only *recognises* — it reads legend tables,
counts symbols, reports areas. All arithmetic happens here, in code, so results
are reproducible and auditable. Every line item carries a `calculation` string
explaining exactly how the quantity was derived, which is what makes a dealer
trust the auto-filled number.

Input: the structured `sheets` list produced by extraction.py (vision) or
dwg_parser.py (exact CAD geometry). Output: catalog line items ready to auto-fill.
"""
import catalog as C


def _round_qty(x):
    # Tiles/paint/ceiling are quoted per sq.ft; keep whole sq.ft (round up — you
    # cannot buy a fraction of coverage and the drawings already add wastage).
    import math
    return int(math.ceil(x - 1e-9))


def _match(spec, keyword_map):
    n = C._norm(spec)
    for kw, sku in keyword_map.items():
        if kw in n:
            return sku
    return None


def _add(line_items, cat_id, qty, unit, calc, source, confidence, product_name=None):
    if cat_id is None or qty <= 0:
        return
    item = C.BY_ID.get(cat_id)
    line_items.append({
        "product_id": cat_id,
        "product_name": product_name or (item["product_name"] if item else "?"),
        "quantity": qty,
        "unit": unit,
        "calculation": calc,
        "source_sheet": source,
        "confidence": confidence,
    })


def process(sheets):
    """sheets: list of recognised-sheet dicts. Returns (line_items, warnings)."""
    line_items = []
    warnings = []

    for sheet in sheets:
        stype = sheet.get("sheet_type", "other")
        title = sheet.get("sheet_title") or stype

        # ---- TILES: area (sq.ft) x wastage -> per-sqft tile SKU -----------
        for row in sheet.get("tile_legend", []) or []:
            spec = row.get("product_spec", "")
            sku = _match(spec, C.TILE_KEYWORDS)
            wastage = (row.get("wastage_pct") or 0) / 100.0
            base = (row.get("area_workshop_sqft") or 0) + (row.get("area_showroom_sqft") or 0)
            if base <= 0:
                # Recognised product but no readable area: surface it instead of
                # silently dropping a big-ticket line (weak vision models hit this).
                if spec:
                    warnings.append(f"[{title}] tile '{spec}' ({row.get('code','?')}) recognised "
                                    f"but its printed area could not be read — enter the sqft manually.")
                continue
            qty = _round_qty(base * (1 + wastage))
            if not sku:
                warnings.append(f"[{title}] tile '{spec}' ({row.get('code','?')}) "
                                f"= {base} sqft +{row.get('wastage_pct',0)}% but no catalog SKU matched.")
                continue
            cid = C.first_id_for_name(sku)
            calc = f"{base} sqft +{row.get('wastage_pct',0)}% wastage = {qty} sqft"
            _add(line_items, cid, qty, "sqft", calc, title,
                 "high" if C.TILE_KEYWORDS else "medium", product_name=sku)

        # ---- FALSE CEILING: area -> per-sqft SKU --------------------------
        fc = sheet.get("false_ceiling_area_sqft")
        if fc:
            cid = C.first_id_for_name(C.FALSE_CEILING_SKU)
            _add(line_items, cid, _round_qty(fc), "sqft",
                 f"false-ceiling area {fc} sqft", title, "medium")

        # ---- PAINT: wall area -> per-sqft SKU -----------------------------
        pa = sheet.get("paint_area_sqft")
        if pa:
            cid = C.first_id_for_name(C.PAINT_SKU)
            _add(line_items, cid, _round_qty(pa), "sqft",
                 f"paintable wall area {pa} sqft", title, "medium")

        # ---- GLASS PARTITION: running ft x height -> per-sqft SKU ---------
        gp = sheet.get("glass_partition_sqft")
        if gp:
            cid = C.first_id_for_name(C.GLASS_PARTITION_SKU)
            _add(line_items, cid, _round_qty(gp), "sqft",
                 f"glass partition area {gp} sqft", title, "medium")

        # ---- DOORS: schedule counts -> per-unit SKU -----------------------
        for row in sheet.get("door_schedule", []) or []:
            count = row.get("count") or 0
            if count <= 0:
                continue
            sku = _match(row.get("spec", "") + " " + row.get("type", ""), C.DOOR_KEYWORDS)
            if not sku:
                warnings.append(f"[{title}] door '{row.get('type')}' x{count} — no SKU matched.")
                continue
            cid = C.first_id_for_name(sku)
            _add(line_items, cid, count, "unit",
                 f"{count} x {row.get('type','door')} ({row.get('spec','')})", title,
                 "high", product_name=sku)

        # ---- ELECTRICAL symbols -> per-unit lights / rolled-up sockets ----
        socket_total = 0
        for row in sheet.get("symbol_counts", []) or []:
            count = row.get("count") or 0
            if count <= 0:
                continue
            desc = row.get("description", "") + " " + row.get("symbol", "")
            sku = _match(desc, C.ELECTRICAL_KEYWORDS)
            if sku == "SWITCH AND SOCKET-MCB":
                socket_total += count
                continue
            if not sku:
                warnings.append(f"[{title}] electrical '{desc.strip()}' x{count} — no SKU matched.")
                continue
            cid = C.first_id_for_name(sku)
            _add(line_items, cid, count, "unit",
                 f"{count} x {row.get('description', sku)}", title, "medium",
                 product_name=sku)
        if socket_total:
            _add(line_items, C.first_id_for_name("SWITCH AND SOCKET-MCB"), socket_total,
                 "unit", f"{socket_total} switch/socket points", title, "medium")

        # ---- FIXTURES / FURNITURE / SIGNAGE: direct name -> SKU -----------
        for row in sheet.get("fixtures", []) or []:
            count = row.get("count") or 0
            name = row.get("name", "")
            if count <= 0 or not name:
                continue
            cid = C.first_id_for_name(name)
            if cid is None:
                warnings.append(f"[{title}] fixture '{name}' x{count} — no SKU matched.")
                continue
            _add(line_items, cid, count, "unit", f"{count} x {name}", title, "medium")

    merged = _merge(line_items)
    return merged, warnings


def _merge(line_items):
    """Sum quantities across sheets for the same catalog id, concatenating the
    per-source calculation notes so the breakdown stays auditable."""
    out = {}
    for li in line_items:
        pid = li["product_id"]
        if pid not in out:
            out[pid] = dict(li)
        else:
            out[pid]["quantity"] += li["quantity"]
            out[pid]["calculation"] += "  +  " + li["calculation"]
            # lowest confidence wins
            order = {"low": 0, "medium": 1, "high": 2}
            if order[li["confidence"]] < order[out[pid]["confidence"]]:
                out[pid]["confidence"] = li["confidence"]
    return sorted(out.values(), key=lambda x: x["product_id"])
