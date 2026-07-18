"""Catalog loading + the mapping tables that connect what the AI recognises on a
drawing to a specific DDSL catalog SKU.

The catalog itself is the same ad-equipments-catalog.json the frontend renders,
so the two never drift. Everything downstream keys off `changeQty_id`, which is
what the order form uses.
"""
import json
import os
import re

_CATALOG_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "ad-equipments-catalog.json")


def load_catalog():
    with open(os.path.abspath(_CATALOG_PATH)) as f:
        return json.load(f)


CATALOG = load_catalog()
# changeQty_id -> item
BY_ID = {item["changeQty_id"]: item for item in CATALOG}


def _norm(s):
    """Loose normalisation for name matching: lowercase, strip punctuation/units."""
    s = s.lower()
    s = re.sub(r"[\"'()x×,\-–]", " ", s)
    # keep thickness tokens ("12mm"/"10mm") — they distinguish tile SKUs
    s = re.sub(r"(\d+)\s*mm\b", r"\1mm", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


# Pre-index the catalog by normalised product name -> list of changeQty_ids.
# There are two price lists in the catalog (showroom items ~1-29, service/workshop
# items ~30-86) so a name can resolve to more than one SKU; we keep both and the
# calc engine picks by zone, falling back to the first.
_NAME_INDEX = {}
for item in CATALOG:
    _NAME_INDEX.setdefault(_norm(item["product_name"]), []).append(item["changeQty_id"])


def find_ids_by_name(name):
    """Return catalog ids whose product name matches `name` (exact-normalised,
    then substring either direction). Empty list if nothing matches."""
    n = _norm(name)
    if n in _NAME_INDEX:
        return list(_NAME_INDEX[n])
    hits = []
    for cat_name, ids in _NAME_INDEX.items():
        if cat_name and (cat_name in n or n in cat_name):
            hits.extend(ids)
    return hits


# ---------------------------------------------------------------------------
# TILE / STONE mapping.
# Drawing legends name a product ("Johnson Endura (Grey 12mm)", "Delphi Grey",
# "Cool Gris", "Akasa Pine", "Terra Grey", "Absolute Black Granite" ...).
# Map each to the catalog SKU that is priced per sq.ft.
# Keys are matched as substrings against the normalised legend spec.
# ---------------------------------------------------------------------------
TILE_KEYWORDS = {
    "delphi nero": "KAJARIA DELPHI NERO",
    "delphi grey": "KAJARIA DELPHI GREY",
    "cool gris": "KAJARIA COOL GRIS",
    "akasa pine": "KAJARIA AKASA PINE",
    "johnson endura yellow": "JOHNSON ENDURA YELLOW PLUS 12 MM",
    "johnson endura grey 12mm": "JOHNSON ENDURA GREY PLUS 12 MM",
    "johnson endura grey 10mm": "JOHNSON ENDURA GREY PLUS 10 MM",
    "johnson endura grey": "JOHNSON ENDURA GREY PLUS 12 MM",  # fallback: no thickness on sheet
    "johnson endura": "JOHNSON ENDURA GREY PLUS 12 MM",       # fallback: colour absent
    "terra grey": "TERRA GREY",
    "absolute black granite": "ABSOLUTE BLACK GRANITE",
    # NOTE: "Manhattan Teak" (seen on Chandamama FL-07) has no catalog SKU. We
    # deliberately do NOT alias it to Akasa Pine — that mis-priced it and, worse,
    # merged two distinct legend rows into one line. It correctly falls through to
    # a "no SKU matched" warning for the operator to resolve.
}

# ---------------------------------------------------------------------------
# ELECTRICAL symbol -> catalog SKU. Symbols come from the electrical legend.
# Lights and points are per-unit; sockets roll up into SWITCH AND SOCKET-MCB.
# ---------------------------------------------------------------------------
ELECTRICAL_KEYWORDS = {
    "panasonic": "PANASONIC PDLM12204 15W TEMP-4000K",
    "downlight": "PANASONIC PDLM12204 15W TEMP-4000K",
    "track light": "TRACK LIGHT",
    "profile light": "PROFILE LIGHT",
    "strip light": "STRIP LIGHT",
    "pendent": "PENDENT",
    "pendant": "PENDENT",
    "batten": "Batten Light",
    "linear suspended": "Linear Suspended Light",
    "socket": "SWITCH AND SOCKET-MCB",
    "switch": "SWITCH AND SOCKET-MCB",
    "distribution board": "SWITCH AND SOCKET-MCB",
    # point types that carry sockets — roll up even when labelled by short name
    "tv point": "SWITCH AND SOCKET-MCB",
    "telephone": "SWITCH AND SOCKET-MCB",
    "epabx": "SWITCH AND SOCKET-MCB",
    "lan": "SWITCH AND SOCKET-MCB",
    "antenna": "SWITCH AND SOCKET-MCB",
}

# ---------------------------------------------------------------------------
# DOOR schedule type -> catalog SKU (per unit). Toughened-glass doors map to the
# glass door SKU; wooden flush doors to Door / Door With Glass.
# ---------------------------------------------------------------------------
DOOR_KEYWORDS = {
    # NB: DDSL drawings misspell "Toughened" as "Toughned" — match both tokens,
    # and BEFORE the generic "glass" fallback, so a toughened-glass door resolves
    # to the Glass Door SKU, not the wooden Door-With-Glass insert.
    "toughned": "Glass Door (7' x 3') with hardwarwe",
    "toughened": "Glass Door (7' x 3') with hardwarwe",
    "glass": "Door With Glass",   # wooden door with a glass insert (fallback)
    "wooden flush": "Door",
    "flush door": "Door",
    "wooden": "Door",
}

# ---------------------------------------------------------------------------
# AREA-BASED finishes: recognised area (sq.ft) -> catalog SKU (per sq.ft).
# ---------------------------------------------------------------------------
PAINT_SKU = "PAINTING"
FALSE_CEILING_SKU = "FALSE CELING"
GLASS_PARTITION_SKU = "Glass Partation Normal"
ELECTRICIAN_SKU = "Electrician"


def first_id_for_name(name, prefer_after=None):
    """Resolve a catalog product name to a single changeQty_id.
    `prefer_after`: when the same name exists in both price lists, prefer an id
    >= this threshold (used to bias workshop items to the service price list)."""
    ids = find_ids_by_name(name)
    if not ids:
        return None
    if prefer_after is not None:
        later = [i for i in ids if i >= prefer_after]
        if later:
            return min(later)
    return min(ids)
