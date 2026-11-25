import csv
import io
import logging
import os
from typing import Any, Literal, TypedDict

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

app = FastAPI(
    title="AgroMind Agent API",
    version="1.0.0",
    description="Independent, evidence-routed agricultural specialist agents.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("AGROMIND_CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class FieldInput(BaseModel):
    crop: str = Field(min_length=1, max_length=80)
    district: str = Field(min_length=1, max_length=80)
    soil: str = Field(min_length=1, max_length=120)
    moisture: str = Field(min_length=1, max_length=20)
    rain: str = Field(min_length=1, max_length=20)
    issue: str = Field(min_length=1, max_length=300)
    image: str | None = None
    specialist: str | None = Field(default=None, max_length=30)


class AgentResult(BaseModel):
    agent: str
    status: str
    summary: str
    confidence: int | None = None


class DiseaseDiagnosis(BaseModel):
    crop_name: str
    disease_name: str
    confidence: str
    severity: str
    symptoms: list[str]
    recommendations: list[str]
    follow_up: list[str]


class SpecialistPrompt(TypedDict):
    agent: Literal["Disease", "Irrigation", "Resources", "Market"]
    image: str | None
    prompt: str
    fallback: str


AUTHORIZED_DOMAINS = {
    "weather": {"api.open-meteo.com", "geocoding-api.open-meteo.com"},
    "market": {"api.data.gov.in", "www.data.gov.in"},
    "production": {"www.data.gov.in"},
    "soil": {"soilhealth.dac.gov.in"},
    "disease": {"krishi-dss.gov.in"},
}

SOURCE_REGISTRY = [
    {
        "name": "Open-Meteo",
        "category": "Weather",
        "url": "https://open-meteo.com/",
        "connect": "Public API",
    },
    {
        "name": "data.gov.in",
        "category": "Mandi and production",
        "url": "https://www.data.gov.in/",
        "connect": "Requires API key",
    },
    {
        "name": "AGMARKNET",
        "category": "Daily mandi prices",
        "url": "https://agmarknet.gov.in/",
        "connect": "Via authorized data.gov.in resource",
    },
    {
        "name": "Krishi DSS",
        "category": "Crop and disease context",
        "url": "https://krishi-dss.gov.in/",
        "connect": "Requires configured project endpoint",
    },
    {
        "name": "Soil Health Card",
        "category": "Soil and nutrient evidence",
        "url": "https://soilhealth.dac.gov.in/",
        "connect": "Requires configured authorized API",
    },
]

AGENT_REGISTRY = {
    "Disease": {"domain": "disease", "sources": ["Krishi DSS"]},
    "Irrigation": {"domain": "weather", "sources": ["Open-Meteo"]},
    "Resources": {"domain": "soil", "sources": ["Soil Health Card"]},
    "Market": {
        "domain": "market",
        "sources": ["data.gov.in", "AGMARKNET", "Agricultural indices"],
    },
}


async def gemini(prompt: str, image: str | None = None) -> str | None:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None

    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    parts: list[dict[str, Any]] = [{"text": prompt}]
    if image and image.startswith("data:"):
        metadata, separator, image_data = image.partition(",")
        mime_type = metadata[5:].split(";", 1)[0]
        if separator and ";base64" in metadata and mime_type.startswith("image/"):
            parts.append(
                {
                    "inlineData": {
                        "mimeType": mime_type,
                        "data": image_data,
                    }
                }
            )
    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 300},
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                url,
                headers={"x-goog-api-key": api_key},
                json=payload,
            )
    except httpx.RequestError as exc:
        logger.warning("Gemini request failed (%s)", type(exc).__name__)
        return None
    if response.status_code != 200:
        return None

    candidates = response.json().get("candidates", [])
    if not candidates:
        return None
    parts = candidates[0].get("content", {}).get("parts", [])
    return "".join(part.get("text", "") for part in parts).strip() or None


async def get_weather(district: str) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            geo = await client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": district, "count": 1, "countryCode": "IN"},
            )
            if geo.status_code != 200:
                return None
            place = (geo.json().get("results") or [None])[0]
            if not place:
                return None

            weather = await client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": place["latitude"],
                    "longitude": place["longitude"],
                    "daily": "precipitation_probability_max",
                    "forecast_days": 3,
                    "timezone": "auto",
                },
            )
    except httpx.RequestError as exc:
        logger.warning("Weather request failed (%s)", type(exc).__name__)
        return None
    if weather.status_code != 200:
        return None
    probabilities = weather.json().get("daily", {}).get(
        "precipitation_probability_max",
        [],
    )
    return {
        "name": "Open-Meteo weather forecast",
        "probability": probabilities[0] if probabilities else None,
    }


async def get_authorized_market(crop: str, district: str) -> dict[str, Any] | None:
    api_key = os.getenv("DATA_GOV_IN_API_KEY")
    if not api_key:
        return None

    resource = os.getenv(
        "AGMARKNET_RESOURCE_ID",
        "9ef84268-d588-465a-a308-a864a43d0070",
    )
    url = f"https://api.data.gov.in/resource/{resource}"

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                url,
                params={
                    "api-key": api_key,
                    "format": "json",
                    "filters[commodity]": crop,
                    "filters[district]": district,
                    "limit": 10,
                },
            )
    except httpx.RequestError as exc:
        logger.warning("Market data request failed (%s)", type(exc).__name__)
        return None
    if response.status_code != 200:
        return None

    records = response.json().get("records", [])
    modal_prices: list[float] = []
    for record in records:
        raw = (
            record.get("modal_price")
            or record.get("modalprice")
            or record.get("Modal Price")
        )
        try:
            modal_prices.append(float(raw))
        except (TypeError, ValueError):
            continue

    return {
        "name": "data.gov.in - Current Daily Price of Various Commodities",
        "recordCount": len(records),
        "averageModal": (
            sum(modal_prices) / len(modal_prices) if modal_prices else None
        ),
        "latestDate": (
            records[0].get("arrival_date")
            or records[0].get("date")
            or records[0].get("Arrival Date")
            if records
            else None
        ),
        "sourceUrl": f"https://www.data.gov.in/resource/{resource}",
    }


async def get_production_index(crop: str) -> dict[str, Any] | None:
    url = os.getenv(
        "AGRICULTURAL_INDEX_URL",
        "https://www.data.gov.in/files/ogdpv2dms/s3fs-public/"
        "datafile/index_numbers_of_agricultural_production_and_productivity_"
        "2006-07_2009.csv",
    )
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(url)
    except httpx.RequestError as exc:
        logger.warning("Production index request failed (%s)", type(exc).__name__)
        return None
    if response.status_code != 200:
        return None

    rows = list(csv.reader(io.StringIO(response.text)))
    crop_key = crop.lower()
    row = next(
        (
            item
            for item in rows
            if len(item) >= 4 and crop_key in item[1].lower()
        ),
        None,
    )
    if row is None:
        row = next(
            (
                item
                for item in rows
                if len(item) >= 4 and "all crops" in item[1].lower()
            ),
            None,
        )
    if row is None:
        return None

    try:
        production = float(row[2])
        productivity = float(row[3])
    except (TypeError, ValueError):
        return None
    return {
        "name": "Index Numbers of Agricultural Production and Productivity",
        "group": row[1],
        "productionIndex": production,
        "productivityIndex": productivity,
        "sourceUrl": url,
    }


async def get_authorized_evidence(
    env_url: str,
    env_key: str,
    payload: dict[str, str],
) -> dict[str, Any] | None:
    url = os.getenv(env_url)
    if not url:
        return None
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv(env_key)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.RequestError as exc:
        logger.warning("Authorized evidence request failed (%s)", type(exc).__name__)
        return None
    if response.status_code != 200:
        return None
    return response.json()


def orchestrate(
    field: FieldInput,
    agents: list[AgentResult],
    market_available: bool | None = None,
) -> tuple[list[str], list[str]]:
    summaries = {item.agent: item.summary.lower() for item in agents}
    conflicts: list[str] = []
    plan: list[str] = []

    try:
        moisture = float(field.moisture)
    except ValueError:
        moisture = None

    try:
        rain = float(field.rain)
    except ValueError:
        rain = None

    if moisture is not None and moisture < 30:
        plan.append("Prioritize root-zone moisture verification before irrigation release")
    elif rain is not None and rain >= 20:
        plan.append("Delay irrigation where the forecast is expected to supply sufficient water")
    else:
        plan.append("Verify soil moisture and district forecast before watering")

    plan.append("Obtain a current soil test before any fertilizer or nutrient amendment")
    plan.append("Photograph symptoms, preserve records and seek local crop-health verification")

    if rain is not None and rain >= 20 and moisture is not None and moisture < 30:
        conflicts.append(
            "Irrigation evidence conflict: depleted moisture but substantial forecast rainfall"
        )
    market_summary = summaries.get("Market")
    if market_summary is not None and market_available is False:
        conflicts.append("Market evidence incomplete: live district mandi comparison unavailable")

    return plan[:4], conflicts


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "AgroMind Python Agent API"}


@app.get("/api/weather/{district}")
async def weather_endpoint(district: str) -> dict[str, Any]:
    weather = await get_weather(district)
    if weather is None:
        raise HTTPException(status_code=404, detail="Weather data unavailable")
    return weather


@app.post("/api/analyze-crop")
async def analyze_crop(field: FieldInput) -> dict[str, Any]:
    diagnosis = await gemini(
        "Analyze this crop condition. Return plain structured JSON only with "
        "crop_name, disease_name, confidence, severity, symptoms, recommendations, "
        "and follow_up. Use any supplied image as visual evidence, distinguish symptoms "
        "from confirmed disease, and do not prescribe doses. "
        f"Crop={field.crop}; district={field.district}; symptoms={field.issue}.",
        field.image,
    )
    if diagnosis is None:
        return {
            "crop_name": field.crop,
            "disease_name": "Unconfirmed",
            "confidence": "Low",
            "severity": "Unknown",
            "symptoms": [field.issue],
            "recommendations": [
                "Compare several leaves",
                "Consult a local crop protection specialist",
            ],
            "follow_up": ["Capture a sharp close-up", "Record spread and growth stage"],
        }
    try:
        import json

        parsed = json.loads(diagnosis)
        return DiseaseDiagnosis(**parsed).model_dump()
    except Exception:
        return {
            "crop_name": field.crop,
            "disease_name": "Unconfirmed",
            "confidence": "Low",
            "severity": "Unknown",
            "symptoms": [field.issue],
            "recommendations": ["Seek expert verification"],
            "follow_up": ["Do not apply an invented treatment dose"],
        }


@app.post("/api/ask-agronomist")
async def ask_agronomist(payload: dict[str, str]) -> dict[str, str]:
    question = payload.get("question", "").strip()
    if not question or len(question) > 1500:
        raise HTTPException(status_code=400, detail="A valid question is required")
    answer = await gemini(
        "You are an agricultural extension assistant. Answer only with evidence-aware "
        "advice, label uncertainty, avoid invented doses and recommend local experts "
        f"for consequential actions. Question: {question}"
    )
    return {"reply": answer or "Verified evidence is unavailable. Consult a local agronomist."}


@app.get("/api/ecosystem")
async def ecosystem_status() -> dict[str, Any]:
    env_by_agent = {
        "Disease": "KRISHI_DSS_API_URL",
        "Irrigation": None,
        "Resources": "SOIL_HEALTH_API_URL",
        "Market": "DATA_GOV_IN_API_KEY",
    }
    agent_statuses = []
    for name, config in AGENT_REGISTRY.items():
        env_name = env_by_agent[name]
        connected = bool(
            (name == "Irrigation")
            or (env_name and os.getenv(env_name))
        )
        agent_statuses.append(
            {
                "name": name,
                "domain": config["domain"],
                "authorizedSources": config["sources"],
                "status": "connected" if connected else "fallback",
            }
        )
    return {
        "orchestrator": {
            "name": "Central Orchestrator",
            "role": "Reconciles specialist evidence and detects conflicts",
            "humanApprovalRequired": True,
        },
        "agents": agent_statuses,
    }


@app.get("/api/source-status")
async def source_status() -> dict[str, Any]:
    connected_by_name = {
        "Open-Meteo": True,
        "data.gov.in": bool(os.getenv("DATA_GOV_IN_API_KEY")),
        "AGMARKNET": bool(os.getenv("DATA_GOV_IN_API_KEY")),
        "Krishi DSS": bool(os.getenv("KRISHI_DSS_API_URL")),
        "Soil Health Card": bool(os.getenv("SOIL_HEALTH_API_URL")),
    }
    return {
        "sources": [
            {
                **source,
                "status": "connected" if connected_by_name[source["name"]] else "unavailable",
            }
            for source in SOURCE_REGISTRY
        ]
    }


@app.post("/api/analyze")
async def analyze(field: FieldInput) -> dict[str, Any]:
    specialist_only = field.specialist in AGENT_REGISTRY
    weather: dict[str, Any] | None = None
    market: dict[str, Any] | None = None
    index: dict[str, Any] | None = None
    soil: dict[str, Any] | None = None
    disease: dict[str, Any] | None = None

    if field.specialist == "Disease":
        disease = await get_authorized_evidence(
            "KRISHI_DSS_API_URL",
            "KRISHI_DSS_API_KEY",
            {"crop": field.crop, "district": field.district},
        )
    elif field.specialist == "Irrigation":
        weather = await get_weather(field.district)
    elif field.specialist == "Resources":
        soil = await get_authorized_evidence(
            "SOIL_HEALTH_API_URL",
            "SOIL_HEALTH_API_KEY",
            {"district": field.district, "soilType": field.soil},
        )
    elif field.specialist == "Market":
        import asyncio

        market, index = await asyncio.gather(
            get_authorized_market(field.crop, field.district),
            get_production_index(field.crop),
        )
    else:
        weather, market, index = await _gather_core_evidence(field)
        soil = await get_authorized_evidence(
            "SOIL_HEALTH_API_URL",
            "SOIL_HEALTH_API_KEY",
            {"district": field.district, "soilType": field.soil},
        )
        disease = await get_authorized_evidence(
            "KRISHI_DSS_API_URL",
            "KRISHI_DSS_API_KEY",
            {"crop": field.crop, "district": field.district},
        )

    specialists: list[SpecialistPrompt] = [
        {
            "agent": "Disease",
            "image": field.image,
            "prompt": (
                "You are the independent Disease Detection Agent. "
                f"crop={field.crop}; issue={field.issue}; district={field.district}; "
                f"disease_evidence={disease or 'not connected'}. "
                "Use the supplied image as visual evidence when available. "
                "Return <=45 words: likely causes, two checks, confidence, escalation threshold."
            ),
            "fallback": (
                "Authorized disease evidence received; field confirmation is required"
                if disease
                else "Krishi DSS evidence is not configured; leaf examination is required"
            ),
        },
        {
            "agent": "Irrigation",
            "image": None,
            "prompt": (
                "You are the independent Smart Irrigation Agent. "
                f"crop={field.crop}; soil={field.soil}; moisture={field.moisture}%; "
                f"rain={field.rain}mm; probability={weather.get('probability') if weather else 'unknown'}. "
                "Give one evidence-based scheduling action and one root-zone check."
            ),
            "fallback": (
                "District forecast connected; verify root-zone moisture"
                if weather
                else "Weather evidence unavailable; keep irrigation conservative"
            ),
        },
        {
            "agent": "Resources",
            "image": None,
            "prompt": (
                "You are the independent Resource Optimization Agent. "
                f"crop={field.crop}; soil={field.soil}; district={field.district}; "
                f"soil_evidence={soil or 'not connected'}. "
                "Recommend only a soil-lab workflow and general nutrient categories."
            ),
            "fallback": (
                "Authorized soil evidence received; verify field-specific lab values"
                if soil
                else "A verified Soil Health Card or lab test is required"
            ),
        },
        {
            "agent": "Market",
            "image": None,
            "prompt": (
                "You are the independent Market Intelligence Agent. "
                f"crop={field.crop}; district={field.district}; "
                f"mandi_records={market.get('recordCount') if market else 'unavailable'}; "
                f"average_modal_price={market.get('averageModal') if market else 'unavailable'}; "
                f"production_index={index.get('productionIndex') if index else 'unavailable'}; "
                f"productivity_index={index.get('productivityIndex') if index else 'unavailable'}; "
                "Explain evidence before harvest or sale timing; do not invent prices."
            ),
            "fallback": (
                f"{market['recordCount']} authorized mandi records found; averages need review"
                if market
                else "District mandi evidence is unavailable"
            ),
        },
    ]

    if field.specialist in {"Disease", "Irrigation", "Resources", "Market"}:
        specialists = [
            specialist
            for specialist in specialists
            if specialist["agent"] == field.specialist
        ]

    agents: list[AgentResult] = []
    for specialist in specialists:
        text = await gemini(specialist["prompt"], specialist["image"])
        agents.append(
            AgentResult(
                agent=specialist["agent"],
                status="ok" if text else "fallback",
                summary=text or specialist["fallback"],
                confidence=None,
            )
        )

    conflicts: list[str] = []
    if specialist_only:
        plan = [
            f"{field.specialist} specialist result is available above. "
            "Run full collaboration for a coordinated plan."
        ]
    else:
        orchestrator_prompt = (
            "You are the central agricultural orchestrator. Reconcile these independent outputs "
            f"and produce 3 concise actions and 1 warning: {agents}. "
            "Require local agronomist, soil-lab, and farmer approval."
        )
        orchestrator_text = await gemini(orchestrator_prompt)
        plan, conflicts = orchestrate(
            field,
            agents,
            market_available=bool(market and market.get("recordCount")),
        )
        if orchestrator_text:
            orchestrated = [
                line.strip(" -*0123456789.)")
                for line in orchestrator_text.replace("\n", " ").split(". ")
                if line.strip()
            ]
            if orchestrated:
                plan = (orchestrated + plan)[:4]

    sources = [
        {
            "name": weather["name"] if weather else "District weather",
            "status": "authorized" if weather else "illustrative",
        },
        {
            "name": "Krishi DSS disease-incidence evidence",
            "status": "authorized" if disease else "illustrative",
        },
        {
            "name": "Government Soil Health Card evidence",
            "status": "authorized" if soil else "illustrative",
        },
        {
            "name": market["name"] if market else "Agmarknet variety-wise daily prices",
            "status": "authorized" if market else "illustrative",
        },
        {
            "name": index["name"] if index else "Agricultural production and productivity index",
            "status": "authorized" if index else "illustrative",
        },
    ]
    source_indices_by_specialist = {
        "Disease": (1,),
        "Irrigation": (0,),
        "Resources": (2,),
        "Market": (3, 4),
    }
    if field.specialist is not None:
        source_indices = source_indices_by_specialist.get(field.specialist)
        if source_indices is not None:
            sources = [sources[index] for index in source_indices]

    warnings = [
        "No treatment, irrigation release, or fertilizer dose is applied automatically.",
        "Local agronomic verification is required before consequential action.",
    ]
    if specialist_only:
        warnings.append(
            f"Only the {field.specialist} specialist ran; cross-agent orchestration was skipped."
        )
    warnings.extend(conflicts)
    return {
        "plan": plan,
        "warnings": warnings,
        "orchestratorRan": not specialist_only,
        "agents": [agent.model_dump() for agent in agents],
        "sources": sources,
        "evidence": {
            "weather": weather,
            "disease": {"name": "Krishi DSS", "connected": bool(disease)} if disease else None,
            "soil": {"name": "Government Soil Health Card", "connected": bool(soil)} if soil else None,
            "market": market,
            "productionIndex": index,
        },
    }


async def _gather_core_evidence(field: FieldInput) -> tuple[
    dict[str, Any] | None,
    dict[str, Any] | None,
    dict[str, Any] | None,
]:
    import asyncio

    weather, market, index = await asyncio.gather(
        get_weather(field.district),
        get_authorized_market(field.crop, field.district),
        get_production_index(field.crop),
    )
    return weather, market, index
