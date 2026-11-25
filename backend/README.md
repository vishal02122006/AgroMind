# AgroMind Python Backend

The Python backend provides independent specialist-agent analysis through FastAPI.

## Run locally

```powershell
python -m pip install -r backend/requirements.txt
python -m uvicorn agromind_api.main:app --app-dir backend --reload --port 8000
```

Open:

- API: http://127.0.0.1:8000
- Interactive API documentation: http://127.0.0.1:8000/docs
- Health: http://127.0.0.1:8000/health
- Ecosystem registry: http://127.0.0.1:8000/api/ecosystem

## Crop image analysis

`POST /api/analyze-crop` and `POST /api/analyze` accept an optional `image` data URI, for example `data:image/jpeg;base64,<base64-data>`. When Gemini is configured, the Disease specialist sends the image along with crop and symptom context. The result is a triage aid, not a confirmed diagnosis; verify it with a local crop-health expert before treatment.

When `POST /api/analyze` includes a `specialist`, only that agent's evidence sources are queried and the orchestrator is skipped. Omit `specialist` to run the full coordinated analysis.

## Test

```powershell
python -m pytest backend/tests -q
python backend/training/evaluate_agents.py
```

The offline benchmark checks prompt construction and guardrails; use `--live` to evaluate configured Gemini responses.

## Evidence configuration

Configure secrets as environment variables; never commit them:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `DATA_GOV_IN_API_KEY`
- `AGMARKNET_RESOURCE_ID`
- `AGRICULTURAL_INDEX_URL`
- `SOIL_HEALTH_API_URL`
- `SOIL_HEALTH_API_KEY`
- `KRISHI_DSS_API_URL`
- `KRISHI_DSS_API_KEY`

The backend uses safe fallbacks when an authorized source or Gemini key is unavailable.
