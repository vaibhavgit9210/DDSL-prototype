# DDSL — AI Drawing Analysis Prototype

Dealers upload a set of architectural fit-out sheets (PDF / PNG / JPG / **DWG / DXF**);
the system reads the drawings with an AI vision model, computes material & equipment
quantities with a deterministic calc engine (every line item carries its `calculation`
string), and auto-fills the DDSL order form.

## Two views, one engine

| View | Path | Design |
|---|---|---|
| **Classic** | [`classic/`](classic/) | DDSL's current order-form design, unchanged — analysis added on top |
| **Modern** | [`modern/`](modern/) | Review-first redesign: 01 Upload → 02 Verify quantities (with provenance + confidence) → 03 Order. Transparent cost breakup, no modals, catalog search instead of an 86-product scroll. |

Landing page: [`index.html`](index.html)

## Live vs demo

Both views are **LIVE by default** — including the hosted GitHub Pages copy. Uploads
are rasterised in the browser (pdf.js, vendored in `assets/vendor/`), sent to the
`ddsl-brain` Cloudflare Worker at `https://ddsl-brain.vaibhavpro9210.workers.dev/analyze`,
read by Claude vision through the Aerolink gateway, and priced by the deterministic
calc engine. Different drawings give different totals; failures surface as errors,
never as canned numbers.

- `?mock` (or `?demo`) — canned Shree Hari Belaganj result, no backend touched.
- `?testpdf=<url>` — fetches a drawing and runs it through the real pipeline (dev hook).
- Point a view at another backend with
  `localStorage.setItem('DDSL_API_URL', 'https://your-host/analyze')`.
- Worker rate limits (KV): 20 analyses/day per IP hash, 100/day global.
- **DWG/DXF is not supported by the worker** (no CAD parser in a Worker) — upload the
  PDF export instead; the UI says so. The local FastAPI backend still parses DXF.

The original FastAPI backend still works for local dev:

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # put the real API key here — .env is gitignored
export $(grep -v '^#' .env | xargs)
uvicorn app:app --port 8000
```

then `localStorage.setItem('DDSL_API_URL', 'http://localhost:8000/analyze')` —
note the localhost backend expects multipart while the worker takes JSON, so use
matching frontend code (the worker contract is what's deployed).

## Architecture

```
classic/ | modern/      Frontends (static, host anywhere)
assets/catalog.js       DDSL product catalog (shared)
assets/mock.js          Canned demo result
assets/prep.js          Browser-side upload prep: PDF → page PNGs via pdf.js
assets/vendor/          Vendored pdf.js (no CDN)
worker/worker.js        ddsl-brain Cloudflare Worker — POST /analyze (JSON),
                        Claude vision via Aerolink + rate limits (KV)
worker/calc.js          JS port of calc_engine.py (kept in behavioural lockstep)
backend/app.py          FastAPI — POST /analyze (multipart) — local dev
backend/extraction.py   Vision model → structured sheets JSON
backend/calc_engine.py  Sheets → catalog line items (all arithmetic in code)
backend/dwg_parser.py   DWG/DXF → exact counts/areas via ezdxf (authoritative)
```

### Deploying the worker

```bash
cd worker
npx wrangler secret put ANTHROPIC_API_KEY   # Aerolink key (same as backend/.env)
npx wrangler secret put IP_SALT             # any random string
npx wrangler deploy
```

## Security — where the API key lives

- The key lives **only** in `backend/.env` (local dev) and as a **wrangler secret**
  on the `ddsl-brain` worker (hosted demo). `.env` is gitignored and must never be
  committed; the secret never appears in the repo or the browser.
- **Never** put the key in the frontend or in this repo: GitHub Pages is static
  hosting — any key shipped to the browser is public.
- GitHub **Actions** secrets don't help here either: they protect CI builds, not a
  static page at runtime. The only safe design is what this repo does — the key stays
  server-side in the FastAPI backend, and the browser talks to the backend, never to
  the AI provider directly.
