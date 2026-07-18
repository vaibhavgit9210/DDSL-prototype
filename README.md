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

## Demo vs live

Both views default to **MOCK mode** (canned result from the Shree Hari Belaganj sample
set) so the hosted GitHub Pages copy works with no backend and **no API key**.

To run live:

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # put the real API key here — .env is gitignored
export $(grep -v '^#' .env | xargs)
uvicorn app:app --port 8000
```

then open a view with `?live` appended (e.g. `classic/index.html?live`).
Point the frontend at a non-localhost backend with:
`localStorage.setItem('DDSL_API_URL', 'https://your-host/analyze')`.

## Architecture

```
classic/ | modern/      Frontends (static, host anywhere)
assets/catalog.js       DDSL product catalog (shared)
assets/mock.js          Canned demo result
backend/app.py          FastAPI — POST /analyze (multipart)
backend/extraction.py   Vision model → structured sheets JSON
backend/calc_engine.py  Sheets → catalog line items (all arithmetic in code)
backend/dwg_parser.py   DWG/DXF → exact counts/areas via ezdxf (authoritative)
```

## Security — where the API key lives

- The key lives **only** in `backend/.env` on the machine running the backend.
  `.env` is gitignored and must never be committed.
- **Never** put the key in the frontend or in this repo: GitHub Pages is static
  hosting — any key shipped to the browser is public.
- GitHub **Actions** secrets don't help here either: they protect CI builds, not a
  static page at runtime. The only safe design is what this repo does — the key stays
  server-side in the FastAPI backend, and the browser talks to the backend, never to
  the AI provider directly.
