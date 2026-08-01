/**
 * ddsl-brain — Cloudflare Worker backend for the hosted DDSL demo.
 *
 * POST /analyze  { files: [{ name, media_type, data_b64 }] }
 *   -> { line_items: [...], warnings: [...], sheets: [...], usage: {...} }
 *
 * The client rasterises PDFs to page images before uploading (pdf.js), so
 * every entry here is a plain image. Recognition runs on Claude vision via the
 * Aerolink gateway (Anthropic-compatible; key is a wrangler secret and never
 * reaches the frontend). All arithmetic happens in calc.js — same engine as
 * backend/calc_engine.py.
 *
 * No raw IPs are stored — rate-limit keys are salted hashes that expire in 2 days.
 */
import { process as calcProcess } from './calc.js';

const MODEL = 'claude-opus-4-8';
const MAX_FILES = 24;               // pages/images per analysis
const MAX_B64_PER_FILE = 3_000_000; // ~2.2 MB decoded
const MAX_B64_TOTAL = 24_000_000;
const IP_LIMIT_PER_DAY = 20;
const GLOBAL_LIMIT_PER_DAY = 100;

const SYSTEM = `You read Indian architectural fit-out drawings for a two-wheeler
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

If a value is not present on the sheet, use null / omit it. Never guess a number.`;

// JSON schema the model must return (mirror of backend/extraction.py).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sheets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sheet_type: { type: 'string',
            enum: ['tiles', 'electrical', 'civil', 'fcl',
                   'rcp', 'elevation', 'furniture', 'other'] },
          sheet_title: { type: 'string' },
          project_name: { type: 'string' },
          tile_legend: { type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              code: { type: 'string' },
              location: { type: 'string' },
              product_spec: { type: 'string' },
              area_workshop_sqft: { type: ['number', 'null'] },
              area_showroom_sqft: { type: ['number', 'null'] },
              wastage_pct: { type: ['number', 'null'] },
            }, required: ['product_spec'] } },
          door_schedule: { type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              type: { type: 'string' },
              width_mm: { type: ['number', 'null'] },
              spec: { type: 'string' },
              count: { type: ['integer', 'null'] },
            }, required: ['type'] } },
          symbol_counts: { type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              symbol: { type: 'string' },
              description: { type: 'string' },
              count: { type: 'integer' },
            }, required: ['description', 'count'] } },
          fixtures: { type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              name: { type: 'string' },
              count: { type: 'integer' },
            }, required: ['name', 'count'] } },
          area_chart: { type: ['array', 'null'], items: {
            type: 'object', additionalProperties: false,
            properties: {
              zone: { type: 'string' },
              sqft: { type: ['number', 'null'] },
            }, required: ['zone'] } },
          false_ceiling_area_sqft: { type: ['number', 'null'] },
          paint_area_sqft: { type: ['number', 'null'] },
          glass_partition_sqft: { type: ['number', 'null'] },
          wall_finishes: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        required: ['sheet_type'],
      },
    },
  },
  required: ['sheets'],
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...CORS },
  });

async function bump(env, key) {
  const cur = parseInt((await env.DDSL_LIMITS.get(key)) || '0', 10);
  await env.DDSL_LIMITS.put(key, String(cur + 1), { expirationTtl: 172800 });
  return cur + 1;
}

async function checkLimits(request, env) {
  if (!env.DDSL_LIMITS) return null; // limits KV not bound — allow
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const buf = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode((env.IP_SALT || 'ddsl') + ip));
  const iphash = [...new Uint8Array(buf.slice(0, 8))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  if (await bump(env, `ip:${iphash}:${day}`) > IP_LIMIT_PER_DAY)
    return 'Daily analysis limit reached for this connection — try again tomorrow.';
  if (await bump(env, `global:${day}`) > GLOBAL_LIMIT_PER_DAY)
    return 'The demo has hit its daily analysis budget — try again tomorrow.';
  return null;
}

async function analyze(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ detail: 'body must be JSON' }, 400); }

  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0)
    return json({ detail: 'no files uploaded' }, 400);
  if (files.length > MAX_FILES)
    return json({ detail: `too many pages (max ${MAX_FILES})` }, 400);

  let total = 0;
  for (const f of files) {
    if (!f?.name || !f?.media_type || typeof f?.data_b64 !== 'string')
      return json({ detail: 'each file needs name, media_type, data_b64' }, 400);
    if (!/^image\/(png|jpeg|webp)$/.test(f.media_type))
      return json({ detail: `${f.name}: unsupported type ${f.media_type} (send page images)` }, 400);
    if (f.data_b64.length > MAX_B64_PER_FILE)
      return json({ detail: `${f.name}: image too large` }, 400);
    total += f.data_b64.length;
  }
  if (total > MAX_B64_TOTAL) return json({ detail: 'upload too large' }, 400);

  const limited = await checkLimits(request, env);
  if (limited) return json({ detail: limited }, 429);

  const content = [{
    type: 'text',
    text: 'Here are the drawing sheets for one project. Extract each sheet into the schema.',
  }];
  for (const f of files) {
    content.push({ type: 'text', text: `--- FILE: ${f.name} ---` });
    content.push({ type: 'image',
      source: { type: 'base64', media_type: f.media_type, data: f.data_b64 } });
  }

  const upstream = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'user-agent': 'ddsl-brain-worker/1.0',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    }),
  });

  if (!upstream.ok) {
    let msg = `upstream ${upstream.status}`;
    try {
      const e = await upstream.json();
      msg = e?.error?.message || e?.error || JSON.stringify(e).slice(0, 300);
    } catch { /* non-JSON upstream error body */ }
    return json({ detail: `vision extraction failed: ${msg}` }, 502);
  }

  const resp = await upstream.json();
  const textBlock = (resp.content || []).find(b => b.type === 'text');
  if (!textBlock) return json({ detail: 'vision extraction failed: empty model response' }, 502);

  let sheets;
  try { sheets = JSON.parse(textBlock.text).sheets; }
  catch { return json({ detail: 'vision extraction failed: unparseable model output' }, 502); }

  const [line_items, warnings] = calcProcess(sheets);
  const usage = {
    model: resp.model,
    input_tokens: resp.usage?.input_tokens ?? 0,
    output_tokens: resp.usage?.output_tokens ?? 0,
  };
  return json({ line_items, warnings, sheets, usage });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/health')
      return json({ ok: true, model: MODEL, dwg_support: false });
    if (url.pathname === '/analyze' && request.method === 'POST') {
      try { return await analyze(request, env); }
      catch (e) { return json({ detail: `worker error: ${e.message}` }, 500); }
    }
    return json({ detail: 'not found' }, 404);
  },
};
