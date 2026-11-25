# AgroMind

AgroMind is an agricultural intelligence portal that Brings together crop-health, irrigation, soil-resource, and market specialists. A central orchestrator combines their results into a field plan, while keeping evidence status and uncertainty visible.

The application includes a Next.js and React Web interface, a FastAPI backend, optional Gemini-powered responses, and optional connections to authorized weather and agricultural data sources. When external services are unavailable or not configured, the app provides limited fallback guidance rather than claiming that live evidence was Received.

## Features

- Independent Disease, Irrigation, Resources, and Market specialists
- Crop image and field-context inputs
- Central plan and evidence-source status
- Optional Open-Meteo weather and configured government data connections
- Optional Supabase authentication
- Human review for consequential agricultural decisions; the app does not automatically apply treatments or operate irrigation equipment

## Requirements

- Node.js 20.9 or newer and npm
- Python 3.10 or newer for the FastAPI backend and Python tests

## Run locally

From The repository root, install the frontend dependencies and create a local environment file:

```powershell
npm ci
Copy-Item .env.example .env.local
```

Add Any required credentials or service URLs to `.env.local`; see [`.env.example`](.env.example). Do not commit real credentials.

Start the web application:

```powershell
npm run dev
```

Open http://localhost:3000.

To run the Python API as well, open a second terminal in the repository root:

```powershell
python -m pip install -r backend\requirements.txt
npm run python:dev
```

The API is available at http://localhost:8000, with interactive documentation at http://localhost:8000/docs. The `AGROMIND_PYTHON_API_URL` setting in `.env.local` tells the web app where to find it.

## Configuration

All integrations are optional. Configure only the services you use:

- `GEMINI_API_KEY` and optionally `GEMINI_MODEL` for model-generated responses
- `DATA_GOV_IN_API_KEY` and optionally `AGMARKNET_RESOURCE_ID` for mandi data
- `AGRICULTURAL_INDEX_URL` for the agricultural production index
- `SOIL_HEALTH_API_URL` and optionally `SOIL_HEALTH_API_KEY` for soil evidence
- `KRISHI_DSS_API_URL` and optionally `KRISHI_DSS_API_KEY` for crop and disease evidence
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for authentication
- `AGROMIND_PYTHON_API_URL` to connect the web app to the Python API

If a source is not configured, its evidence is reported as unavailable; confirm recommendations with local agricultural experts before taking consequential action.

## Tests and checks

```powershell
npm run lint
npm run build
npm run python:test
npm run agents:benchmark
```

The Python API's local setup and test instructions are also available in [`backend/README.md`](backend/README.md).
