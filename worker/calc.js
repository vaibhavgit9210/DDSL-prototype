// Deterministic calculation engine — JS port of backend/calc_engine.py + the
// matching tables from backend/catalog.py. The LLM only *recognises* (legend
// tables, symbol counts, areas); ALL arithmetic happens here so results are
// reproducible and every line item carries an auditable `calculation` string.
// Keep this file in behavioural lockstep with the Python originals.
import CATALOG from './catalog.js';

const BY_ID = Object.fromEntries(CATALOG.map(i => [i.changeQty_id, i]));

// Loose normalisation for name matching: lowercase, strip punctuation/units.
function norm(s) {
  s = s.toLowerCase();
  s = s.replace(/["'()x×,\-–]/g, ' ');
  // keep thickness tokens ("12mm"/"10mm") — they distinguish tile SKUs
  s = s.replace(/(\d+)\s*mm\b/g, '$1mm');
  return s.replace(/\s+/g, ' ').trim();
}

// normalised product name -> [changeQty_id, ...] (two price lists in the
// catalog, so a name can resolve to more than one SKU).
const NAME_INDEX = {};
for (const item of CATALOG) {
  const n = norm(item.product_name);
  (NAME_INDEX[n] = NAME_INDEX[n] || []).push(item.changeQty_id);
}

function findIdsByName(name) {
  const n = norm(name);
  if (NAME_INDEX[n]) return [...NAME_INDEX[n]];
  const hits = [];
  for (const [catName, ids] of Object.entries(NAME_INDEX)) {
    if (catName && (n.includes(catName) || catName.includes(n))) hits.push(...ids);
  }
  return hits;
}

function firstIdForName(name) {
  const ids = findIdsByName(name);
  return ids.length ? Math.min(...ids) : null;
}

// Ordered [keyword, SKU] pairs — order matters (specific before generic),
// matched as substrings against the normalised spec.
const TILE_KEYWORDS = [
  ['delphi nero', 'KAJARIA DELPHI NERO'],
  ['delphi grey', 'KAJARIA DELPHI GREY'],
  ['cool gris', 'KAJARIA COOL GRIS'],
  ['akasa pine', 'KAJARIA AKASA PINE'],
  ['johnson endura yellow', 'JOHNSON ENDURA YELLOW PLUS 12 MM'],
  ['johnson endura grey 12mm', 'JOHNSON ENDURA GREY PLUS 12 MM'],
  ['johnson endura grey 10mm', 'JOHNSON ENDURA GREY PLUS 10 MM'],
  ['johnson endura grey', 'JOHNSON ENDURA GREY PLUS 12 MM'],  // fallback: no thickness on sheet
  ['johnson endura', 'JOHNSON ENDURA GREY PLUS 12 MM'],       // fallback: colour absent
  ['terra grey', 'TERRA GREY'],
  ['absolute black granite', 'ABSOLUTE BLACK GRANITE'],
  // NOTE: "Manhattan Teak" deliberately unmapped -> "no SKU matched" warning.
];

const ELECTRICAL_KEYWORDS = [
  ['panasonic', 'PANASONIC PDLM12204 15W TEMP-4000K'],
  ['downlight', 'PANASONIC PDLM12204 15W TEMP-4000K'],
  ['track light', 'TRACK LIGHT'],
  ['profile light', 'PROFILE LIGHT'],
  ['strip light', 'STRIP LIGHT'],
  ['pendent', 'PENDENT'],
  ['pendant', 'PENDENT'],
  ['batten', 'Batten Light'],
  ['linear suspended', 'Linear Suspended Light'],
  ['socket', 'SWITCH AND SOCKET-MCB'],
  ['switch', 'SWITCH AND SOCKET-MCB'],
  ['distribution board', 'SWITCH AND SOCKET-MCB'],
  // point types that carry sockets — roll up even when labelled by short name
  ['tv point', 'SWITCH AND SOCKET-MCB'],
  ['telephone', 'SWITCH AND SOCKET-MCB'],
  ['epabx', 'SWITCH AND SOCKET-MCB'],
  ['lan', 'SWITCH AND SOCKET-MCB'],
  ['antenna', 'SWITCH AND SOCKET-MCB'],
];

const DOOR_KEYWORDS = [
  // NB: DDSL drawings misspell "Toughened" as "Toughned" — match both tokens,
  // and BEFORE the generic "glass" fallback.
  ['toughned', "Glass Door (7' x 3') with hardwarwe"],
  ['toughened', "Glass Door (7' x 3') with hardwarwe"],
  ['glass', 'Door With Glass'],   // wooden door with a glass insert (fallback)
  ['wooden flush', 'Door'],
  ['flush door', 'Door'],
  ['wooden', 'Door'],
];

const PAINT_SKU = 'PAINTING';
const FALSE_CEILING_SKU = 'FALSE CELING';
const GLASS_PARTITION_SKU = 'Glass Partation Normal';

const roundQty = x => Math.ceil(x - 1e-9);

function match(spec, keywordPairs) {
  const n = norm(spec);
  for (const [kw, sku] of keywordPairs) if (n.includes(kw)) return sku;
  return null;
}

function add(lineItems, catId, qty, unit, calc, source, confidence, productName) {
  if (catId === null || catId === undefined || qty <= 0) return;
  const item = BY_ID[catId];
  lineItems.push({
    product_id: catId,
    product_name: productName || (item ? item.product_name : '?'),
    quantity: qty,
    unit,
    calculation: calc,
    source_sheet: source,
    confidence,
  });
}

export function process(sheets) {
  const lineItems = [];
  const warnings = [];

  for (const sheet of sheets || []) {
    const stype = sheet.sheet_type || 'other';
    const title = sheet.sheet_title || stype;

    // ---- TILES: area (sq.ft) x wastage -> per-sqft tile SKU -----------
    for (const row of sheet.tile_legend || []) {
      const spec = row.product_spec || '';
      const sku = match(spec, TILE_KEYWORDS);
      const wastage = (row.wastage_pct || 0) / 100.0;
      const base = (row.area_workshop_sqft || 0) + (row.area_showroom_sqft || 0);
      if (base <= 0) {
        // Recognised product but no readable area: surface it instead of
        // silently dropping a big-ticket line (weak vision models hit this).
        if (spec) warnings.push(`[${title}] tile '${spec}' (${row.code ?? '?'}) recognised ` +
          'but its printed area could not be read — enter the sqft manually.');
        continue;
      }
      const qty = roundQty(base * (1 + wastage));
      if (!sku) {
        warnings.push(`[${title}] tile '${spec}' (${row.code ?? '?'}) ` +
          `= ${base} sqft +${row.wastage_pct ?? 0}% but no catalog SKU matched.`);
        continue;
      }
      const cid = firstIdForName(sku);
      const calc = `${base} sqft +${row.wastage_pct ?? 0}% wastage = ${qty} sqft`;
      add(lineItems, cid, qty, 'sqft', calc, title, 'high', sku);
    }

    // ---- FALSE CEILING: area -> per-sqft SKU --------------------------
    const fc = sheet.false_ceiling_area_sqft;
    if (fc) add(lineItems, firstIdForName(FALSE_CEILING_SKU), roundQty(fc), 'sqft',
      `false-ceiling area ${fc} sqft`, title, 'medium');

    // ---- PAINT: wall area -> per-sqft SKU -----------------------------
    const pa = sheet.paint_area_sqft;
    if (pa) add(lineItems, firstIdForName(PAINT_SKU), roundQty(pa), 'sqft',
      `paintable wall area ${pa} sqft`, title, 'medium');

    // ---- GLASS PARTITION: area -> per-sqft SKU ------------------------
    const gp = sheet.glass_partition_sqft;
    if (gp) add(lineItems, firstIdForName(GLASS_PARTITION_SKU), roundQty(gp), 'sqft',
      `glass partition area ${gp} sqft`, title, 'medium');

    // ---- DOORS: schedule counts -> per-unit SKU -----------------------
    for (const row of sheet.door_schedule || []) {
      const count = row.count || 0;
      if (count <= 0) continue;
      const sku = match((row.spec || '') + ' ' + (row.type || ''), DOOR_KEYWORDS);
      if (!sku) {
        warnings.push(`[${title}] door '${row.type ?? 'null'}' x${count} — no SKU matched.`);
        continue;
      }
      const cid = firstIdForName(sku);
      add(lineItems, cid, count, 'unit',
        `${count} x ${row.type ?? 'door'} (${row.spec ?? ''})`, title, 'high', sku);
    }

    // ---- ELECTRICAL symbols -> per-unit lights / rolled-up sockets ----
    let socketTotal = 0;
    for (const row of sheet.symbol_counts || []) {
      const count = row.count || 0;
      if (count <= 0) continue;
      const desc = (row.description || '') + ' ' + (row.symbol || '');
      const sku = match(desc, ELECTRICAL_KEYWORDS);
      if (sku === 'SWITCH AND SOCKET-MCB') { socketTotal += count; continue; }
      if (!sku) {
        warnings.push(`[${title}] electrical '${desc.trim()}' x${count} — no SKU matched.`);
        continue;
      }
      const cid = firstIdForName(sku);
      add(lineItems, cid, count, 'unit',
        `${count} x ${row.description ?? sku}`, title, 'medium', sku);
    }
    if (socketTotal)
      add(lineItems, firstIdForName('SWITCH AND SOCKET-MCB'), socketTotal, 'unit',
        `${socketTotal} switch/socket points`, title, 'medium');

    // ---- FIXTURES / FURNITURE / SIGNAGE: direct name -> SKU -----------
    for (const row of sheet.fixtures || []) {
      const count = row.count || 0;
      const name = row.name || '';
      if (count <= 0 || !name) continue;
      const cid = firstIdForName(name);
      if (cid === null) {
        warnings.push(`[${title}] fixture '${name}' x${count} — no SKU matched.`);
        continue;
      }
      add(lineItems, cid, count, 'unit', `${count} x ${name}`, title, 'medium');
    }
  }

  return [merge(lineItems), warnings];
}

// Sum quantities across sheets for the same catalog id, concatenating the
// per-source calculation notes so the breakdown stays auditable.
function merge(lineItems) {
  const out = new Map();
  const order = { low: 0, medium: 1, high: 2 };
  for (const li of lineItems) {
    const pid = li.product_id;
    if (!out.has(pid)) out.set(pid, { ...li });
    else {
      const cur = out.get(pid);
      cur.quantity += li.quantity;
      cur.calculation += '  +  ' + li.calculation;
      if (order[li.confidence] < order[cur.confidence]) cur.confidence = li.confidence;
    }
  }
  return [...out.values()].sort((a, b) => a.product_id - b.product_id);
}
