import httpx
import pytest
from fastapi.testclient import TestClient

from agromind_api.main import AgentResult, FieldInput, app, orchestrate


client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_gemini_network_error_returns_specialist_fallback(monkeypatch) -> None:
    async def fail_request(_request):
        raise httpx.ConnectError("offline")

    original_async_client = httpx.AsyncClient

    def failing_async_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(fail_request)
        return original_async_client(*args, **kwargs)

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(
        "agromind_api.main.httpx.AsyncClient", failing_async_client
    )

    response = client.post(
        "/api/analyze",
        json={
            "crop": "Tomato",
            "district": "Anantapur",
            "soil": "Red sandy loam",
            "moisture": "22",
            "rain": "18",
            "issue": "Yellow-brown spots",
            "specialist": "Disease",
        },
    )

    assert response.status_code == 200
    assert response.json()["agents"][0]["status"] == "fallback"


def test_weather_network_error_is_reported_as_unavailable(monkeypatch) -> None:
    async def fail_request(_request):
        raise httpx.ConnectError("offline")

    original_async_client = httpx.AsyncClient

    def failing_async_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(fail_request)
        return original_async_client(*args, **kwargs)

    monkeypatch.setattr(
        "agromind_api.main.httpx.AsyncClient", failing_async_client
    )

    response = client.get("/api/weather/Anantapur")

    assert response.status_code == 404
    assert response.json()["detail"] == "Weather data unavailable"


def test_analyze_returns_all_specialists(monkeypatch) -> None:
    gemini_prompts = []

    async def no_core_evidence(field):
        return None, None, None

    async def no_external_evidence(*args, **kwargs):
        return None

    async def no_gemini(prompt, image=None):
        gemini_prompts.append(prompt)
        return None

    monkeypatch.setattr("agromind_api.main._gather_core_evidence", no_core_evidence)
    monkeypatch.setattr("agromind_api.main.get_authorized_evidence", no_external_evidence)
    monkeypatch.setattr("agromind_api.main.gemini", no_gemini)

    response = client.post(
        "/api/analyze",
        json={
            "crop": "Tomato",
            "district": "Anantapur",
            "soil": "Red sandy loam",
            "moisture": "22",
            "rain": "18",
            "issue": "Yellow-brown spots",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert [agent["agent"] for agent in body["agents"]] == [
        "Disease",
        "Irrigation",
        "Resources",
        "Market",
    ]
    assert len(body["plan"]) >= 3
    assert len(body["sources"]) == 5
    assert body["orchestratorRan"] is True
    assert all(agent["confidence"] is None for agent in body["agents"])
    assert any(
        "Treat mandi-record freshness as unverified" in prompt
        for prompt in gemini_prompts
    )


def test_ecosystem_reports_all_agents_and_orchestrator(monkeypatch) -> None:
    for env_name in (
        "KRISHI_DSS_API_URL",
        "SOIL_HEALTH_API_URL",
        "DATA_GOV_IN_API_KEY",
    ):
        monkeypatch.delenv(env_name, raising=False)

    response = client.get("/api/ecosystem")
    assert response.status_code == 200
    body = response.json()
    assert body["orchestrator"]["name"] == "Central Orchestrator"
    assert [agent["name"] for agent in body["agents"]] == [
        "Disease",
        "Irrigation",
        "Resources",
        "Market",
    ]
    irrigation = next(agent for agent in body["agents"] if agent["name"] == "Irrigation")
    assert irrigation["authorizedSources"] == ["Open-Meteo"]
    assert irrigation["status"] == "public"
    assert all(
        agent["status"] == "not_configured"
        for agent in body["agents"]
        if agent["name"] != "Irrigation"
    )


def test_source_status_reports_configuration_not_live_health(monkeypatch) -> None:
    for env_name in (
        "KRISHI_DSS_API_URL",
        "SOIL_HEALTH_API_URL",
        "DATA_GOV_IN_API_KEY",
    ):
        monkeypatch.delenv(env_name, raising=False)

    response = client.get("/api/source-status")
    assert response.status_code == 200
    sources = {source["name"]: source for source in response.json()["sources"]}
    assert sources["Open-Meteo"]["status"] == "public"
    assert all(
        source["status"] == "not_configured"
        for name, source in sources.items()
        if name != "Open-Meteo"
    )
    assert set(sources) == {
        "Open-Meteo",
        "data.gov.in",
        "AGMARKNET",
        "Krishi DSS",
        "Soil Health Card",
    }
    monkeypatch.setenv("DATA_GOV_IN_API_KEY", "configured")
    monkeypatch.setenv("KRISHI_DSS_API_URL", "https://example.test/disease")
    monkeypatch.setenv("SOIL_HEALTH_API_URL", "https://example.test/soil")
    configured = {
        source["name"]: source["status"]
        for source in client.get("/api/source-status").json()["sources"]
    }
    assert configured["data.gov.in"] == "configured"
    assert configured["AGMARKNET"] == "configured"
    assert configured["Krishi DSS"] == "configured"
    assert configured["Soil Health Card"] == "configured"
    assert configured["Open-Meteo"] == "public"


def test_market_conflict_uses_freshness_not_summary_wording() -> None:
    field = FieldInput(
        crop="Tomato",
        district="Anantapur",
        soil="Red sandy loam",
        moisture="22",
        rain="18",
        issue="Yellow-brown spots",
    )
    market_agent = AgentResult(
        agent="Market",
        status="ok",
        summary="Current prices show a seasonal increase.",
        confidence=None,
    )

    _, current_conflicts = orchestrate(field, [market_agent], market_current=True)
    _, unverified_conflicts = orchestrate(field, [market_agent], market_current=False)

    assert not any("freshness is unverified" in item for item in current_conflicts)
    assert any("freshness is unverified" in item for item in unverified_conflicts)


def test_market_prompt_discloses_unverified_dates_and_historical_index(
    monkeypatch,
) -> None:
    captured_prompts = []

    async def market_evidence(crop, district):
        return {
            "name": "data.gov.in mandi price records",
            "recordCount": 2,
            "averageModal": 2400,
            "recordDates": ["01/02/2026", "04/02/2026"],
            "freshnessVerified": False,
        }

    async def production_index(crop):
        return {
            "name": "Historical agricultural production index",
            "productionIndex": 101.2,
            "productivityIndex": 98.4,
            "temporalScope": "Historical dataset; not a current market signal",
        }

    async def no_gemini(prompt, image=None):
        captured_prompts.append(prompt)
        return None

    monkeypatch.setattr("agromind_api.main.get_authorized_market", market_evidence)
    monkeypatch.setattr("agromind_api.main.get_production_index", production_index)
    monkeypatch.setattr("agromind_api.main.gemini", no_gemini)

    response = client.post(
        "/api/analyze",
        json={
            "crop": "Tomato",
            "district": "Anantapur",
            "soil": "Red sandy loam",
            "moisture": "22",
            "rain": "18",
            "issue": "Yellow-brown spots",
            "specialist": "Market",
        },
    )

    assert response.status_code == 200
    assert "mandi_record_dates=['01/02/2026', '04/02/2026']" in captured_prompts[0]
    assert "market_freshness_verified=False" in captured_prompts[0]
    assert "historical context only" in captured_prompts[0]
    assert any("freshness are not verified" in item for item in response.json()["warnings"])


@pytest.mark.parametrize(
    ("specialist", "expected_evidence_calls", "expected_source_count"),
    [
        ("Disease", ["KRISHI_DSS_API_URL"], 1),
        ("Irrigation", ["weather"], 1),
        ("Resources", ["SOIL_HEALTH_API_URL"], 1),
        ("Market", ["market", "production"], 2),
    ],
)
def test_specialist_only_run_uses_only_selected_evidence(
    monkeypatch, specialist, expected_evidence_calls, expected_source_count
) -> None:
    evidence_calls = []
    gemini_calls = []

    async def no_core_evidence(field):
        evidence_calls.append("core")
        return None, None, None

    async def capture_external_evidence(url_env, *args, **kwargs):
        evidence_calls.append(url_env)
        return None

    async def capture_weather(district):
        evidence_calls.append("weather")
        return None

    async def capture_market(crop, district):
        evidence_calls.append("market")
        return None

    async def capture_production_index(crop):
        evidence_calls.append("production")
        return None

    async def capture_gemini(prompt, image=None):
        gemini_calls.append(prompt)
        return None

    monkeypatch.setattr("agromind_api.main._gather_core_evidence", no_core_evidence)
    monkeypatch.setattr(
        "agromind_api.main.get_authorized_evidence", capture_external_evidence
    )
    monkeypatch.setattr("agromind_api.main.get_weather", capture_weather)
    monkeypatch.setattr("agromind_api.main.get_authorized_market", capture_market)
    monkeypatch.setattr("agromind_api.main.get_production_index", capture_production_index)
    monkeypatch.setattr("agromind_api.main.gemini", capture_gemini)

    response = client.post(
        "/api/analyze",
        json={
            "crop": "Tomato",
            "district": "Anantapur",
            "soil": "Red sandy loam",
            "moisture": "22",
            "rain": "18",
            "issue": "Yellow-brown spots",
            "specialist": specialist,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert [agent["agent"] for agent in body["agents"]] == [specialist]
    assert evidence_calls == expected_evidence_calls
    assert len(gemini_calls) == 1
    assert len(body["sources"]) == expected_source_count
    assert "full collaboration" in body["plan"][0].lower()
    assert body["orchestratorRan"] is False


def test_analyze_crop_includes_image_in_gemini_request(monkeypatch) -> None:
    import json

    import httpx

    image = "data:image/jpeg;base64,aGVsbG8="
    requests = []
    diagnosis = (
        '{"crop_name":"Tomato","disease_name":"Unconfirmed","confidence":"Low",'
        '"severity":"Unknown","symptoms":["spots"],'
        '"recommendations":["Compare symptoms"],"follow_up":["Consult an expert"]}'
    )

    async def capture_request(request):
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": diagnosis}]}}]},
        )

    original_async_client = httpx.AsyncClient

    def mock_async_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(capture_request)
        return original_async_client(*args, **kwargs)

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr("agromind_api.main.httpx.AsyncClient", mock_async_client)

    response = client.post(
        "/api/analyze-crop",
        json={
            "crop": "Tomato",
            "district": "Anantapur",
            "soil": "Red sandy loam",
            "moisture": "22",
            "rain": "18",
            "issue": "Yellow-brown spots",
            "image": image,
        },
    )

    assert response.status_code == 200
    assert requests[0]["contents"][0]["parts"][1] == {
        "inlineData": {"mimeType": "image/jpeg", "data": "aGVsbG8="}
    }


@pytest.mark.parametrize("model_response", ["not-json", "[]"])
def test_analyze_crop_invalid_model_output_returns_unconfirmed(
    monkeypatch, model_response
) -> None:
    async def invalid_gemini(prompt, image=None):
        return model_response

    monkeypatch.setattr("agromind_api.main.gemini", invalid_gemini)

    response = client.post(
        "/api/analyze-crop",
        json={
            "crop": "Tomato",
            "district": "Anantapur",
            "soil": "Red sandy loam",
            "moisture": "22",
            "rain": "18",
            "issue": "Yellow-brown spots",
        },
    )

    assert response.status_code == 200
    assert response.json()["disease_name"] == "Unconfirmed"
    assert response.json()["confidence"] == "Low"


def test_analyze_passes_image_only_to_disease_agent(monkeypatch) -> None:
    async def no_core_evidence(field):
        return None, None, None

    async def no_external_evidence(*args, **kwargs):
        return None

    calls = []

    async def no_gemini(prompt, image=None):
        calls.append((prompt, image))
        return None

    monkeypatch.setattr("agromind_api.main._gather_core_evidence", no_core_evidence)
    monkeypatch.setattr("agromind_api.main.get_authorized_evidence", no_external_evidence)
    monkeypatch.setattr("agromind_api.main.gemini", no_gemini)

    image = "data:image/jpeg;base64,aGVsbG8="
    response = client.post(
        "/api/analyze",
        json={
            "crop": "Tomato",
            "district": "Anantapur",
            "soil": "Red sandy loam",
            "moisture": "22",
            "rain": "18",
            "issue": "Yellow-brown spots",
            "image": image,
            "specialist": "Disease",
        },
    )

    assert response.status_code == 200
    assert calls[0][1] == image
    assert len(calls) == 1
