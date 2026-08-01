/**
 * ddsl-brain — Cloudflare Worker backend for the hosted DDSL demo.
 *
 * POST /analyze  { files: [{ name, media_type, data_b64 }] }
 *   -> { line_items: [...], warnings: [...], sheets: [...], usage: {...} }
 *
 * The client rasterises PDFs to page images before uploading (pdf.js), so
 * every entry here is a plain image. Recognition cascades through vision
 * engines until one succeeds (all keys are wrangler secrets — nothing reaches
 * the frontend):
 *   1. Claude via the Aerolink gateway (ANTHROPIC_API_KEY — best quality, paid)
 *   2. Gemini free tier (GEMINI_API_KEY — good, free)
 *   3. Cloudflare Workers AI (keyless [ai] binding — always available, weakest)
 * All arithmetic happens in calc.js — same engine as backend/calc_engine.py.
 *
 * No raw IPs are stored — rate-limit keys are salted hashes that expire in 2 days.
 */
import { process as calcProcess } from './calc.js';

const MODEL = 'claude-opus-4-8';
const GEMINI_MODEL_DEFAULT = 'gemini-2.5-flash';
const WORKERS_AI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const MAX_FILES = 24;               // pages/images per analysis
const MAX_B64_PER_FILE = 4_500_000; // ~3.3 MB decoded (3000px A1 render)
const MAX_B64_TOTAL = 20_000_000;   // stay under Gemini/Anthropic request caps
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

// One sheet, for engines that read a single image per call (Workers AI).
const SHEET_SCHEMA = SCHEMA.properties.sheets.items;

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

  // Cascade: first engine to return sheets wins.
  const engines = [];
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL)
    engines.push(['claude', extractViaClaude]);
  if (env.GEMINI_API_KEY) engines.push(['gemini', extractViaGemini]);
  if (env.AI) engines.push(['workers-ai', extractViaWorkersAI]);

  const failures = [];
  for (const [name, engine] of engines) {
    try {
      const { sheets, usage, extraWarnings } = await engine(env, files);
      const [line_items, warnings] = calcProcess(sheets);
      return json({ line_items, warnings: [...warnings, ...(extraWarnings || [])],
                    sheets, usage });
    } catch (e) {
      failures.push(`[${name}] ${e.message}`);
    }
  }
  return json({ detail: `vision extraction failed: ${failures.join('  |  ') || 'no engine configured'}` }, 502);
}

// ---- engine 1: Claude via Aerolink (Anthropic-compatible) -----------------
async function extractViaClaude(env, files) {
  const content = [{
    type: 'text',
    text: 'Here are the drawing sheets for one project. Extract each sheet into the schema.',
  }];
  for (const f of files) {
    content.push({ type: 'text', text: `--- FILE: ${f.name} ---` });
    content.push({ type: 'image',
      source: { type: 'base64', media_type: f.media_type, data: f.data_b64 } });
  }

  const resp = await upstreamJson(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  }, {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  });

  const textBlock = (resp.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('empty model response');
  return {
    sheets: JSON.parse(textBlock.text).sheets,
    usage: { model: resp.model,
             input_tokens: resp.usage?.input_tokens ?? 0,
             output_tokens: resp.usage?.output_tokens ?? 0 },
  };
}

// ---- engine 2: Gemini free tier -------------------------------------------
async function extractViaGemini(env, files) {
  const model = env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const parts = [{ text: 'Here are the drawing sheets for one project. Extract each sheet into the schema.' }];
  for (const f of files) {
    parts.push({ text: `--- FILE: ${f.name} ---` });
    parts.push({ inline_data: { mime_type: f.media_type, data: f.data_b64 } });
  }

  const resp = await upstreamJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { 'x-goog-api-key': env.GEMINI_API_KEY },
    {
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: geminiSchema(SCHEMA),
        maxOutputTokens: 16384,
      },
    });

  const text = resp.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
  if (!text) throw new Error(`empty response (finishReason ${resp.candidates?.[0]?.finishReason || '?'})`);
  return {
    sheets: JSON.parse(text).sheets,
    usage: { model,
             input_tokens: resp.usageMetadata?.promptTokenCount ?? 0,
             output_tokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
             free: true },
  };
}

// Gemini's responseSchema dialect: no union types (use nullable), no
// additionalProperties. Convert our JSON schema recursively.
function geminiSchema(s) {
  if (Array.isArray(s.type)) {
    const t = s.type.find(x => x !== 'null');
    return geminiSchema({ ...s, type: t, nullable: true });
  }
  const out = {};
  if (s.type) out.type = s.type;
  if (s.nullable) out.nullable = true;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = geminiSchema(s.items);
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = geminiSchema(v);
  }
  if (s.required) out.required = s.required;
  return out;
}

// ---- engine 3: Cloudflare Workers AI (keyless) -----------------------------
// The vision model takes ONE image per call, so sheets are extracted
// per-image and merged. Weakest reader — last resort so the free demo always
// has something behind it.
async function extractViaWorkersAI(env, files) {
  const sheets = [];
  const extraWarnings = [];
  for (const f of files) {
    try {
      // guided_json = constrained decoding to ONE sheet object per image.
      const resp = await runWorkersAI(env, {
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: [
            { type: 'text', text:
              `FILE: ${f.name} — extract this single sheet into the JSON schema. ` +
              'FIRST find the legend/schedule TABLE (a boxed grid, often near a corner, with ' +
              'columns like Legend/Symbol/Location/Specifications/Area (sqft)). Zoom your attention ' +
              'onto that table and read it cell by cell, row by row — do NOT read only the large ' +
              'labels on the plan. Tile legend rows MUST include the printed Area values in sqft ' +
              '(Workshop and/or Showroom columns) as area_workshop_sqft / area_showroom_sqft plus ' +
              'the wastage percent — a row without its printed area is useless. "---" means null. ' +
              'Door schedules MUST include the count of each type; electrical legends MUST include ' +
              'the count per symbol. Report numbers exactly as printed; never invent one.' },
            { type: 'image_url',
              image_url: { url: `data:${f.media_type};base64,${f.data_b64}` } },
          ] },
        ],
        guided_json: SHEET_SCHEMA,
        max_tokens: 4096,
      });
      const raw = typeof resp.response === 'string'
        ? parseLenient(resp.response)
        : resp.response;
      const got = raw?.sheets;
      if (Array.isArray(got)) sheets.push(...got);
      else if (raw?.sheet_type) sheets.push(raw); // model returned a bare sheet
      else extraWarnings.push(`[${f.name}] fallback reader returned nothing usable.`);
    } catch (e) {
      extraWarnings.push(`[${f.name}] fallback reader failed: ${e.message}`);
    }
  }
  if (!sheets.length)
    throw new Error(`fallback reader extracted nothing from any sheet (${extraWarnings.join('; ') || 'no detail'})`);
  extraWarnings.push('Read by the free fallback model (Workers AI) — accuracy is lower; verify every quantity against the drawings.');
  return { sheets, usage: { model: WORKERS_AI_MODEL, input_tokens: 0, output_tokens: 0, free: true },
           extraWarnings };
}

// Small models wrap JSON in prose/code fences; dig the outermost object out.
function parseLenient(text) {
  try { return JSON.parse(text); } catch { /* keep digging */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`model returned no JSON: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(start, end + 1));
}

// Llama models on Workers AI are gated behind a one-time per-account license
// acceptance (error 5016: submit the prompt 'agree'). Handle it and retry once.
async function runWorkersAI(env, input) {
  try {
    return await env.AI.run(WORKERS_AI_MODEL, input);
  } catch (e) {
    if (!/5016|submit the prompt 'agree'/.test(e.message)) throw e;
    await env.AI.run(WORKERS_AI_MODEL, { prompt: 'agree' });
    return env.AI.run(WORKERS_AI_MODEL, input);
  }
}

// POST JSON, return parsed JSON, throw with the upstream's error text on non-2xx.
async function upstreamJson(url, headers, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'user-agent': 'ddsl-brain-worker/1.0', ...headers },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `upstream ${r.status}`;
    try {
      const e = await r.json();
      msg = e?.error?.message || e?.error || JSON.stringify(e).slice(0, 300);
    } catch { /* non-JSON upstream error body */ }
    throw new Error(msg);
  }
  return r.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/health')
      return json({ ok: true, dwg_support: false, engines: [
        ...(env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL ? [`claude (${MODEL})`] : []),
        ...(env.GEMINI_API_KEY ? [`gemini (${env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT})`] : []),
        ...(env.AI ? [`workers-ai (${WORKERS_AI_MODEL})`] : []),
      ] });
    if (url.pathname === '/analyze' && request.method === 'POST') {
      try { return await analyze(request, env); }
      catch (e) { return json({ detail: `worker error: ${e.message}` }, 500); }
    }
    return json({ detail: 'not found' }, 404);
  },
};
