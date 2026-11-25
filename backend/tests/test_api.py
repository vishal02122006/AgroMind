import pytest
from fastapi.testclient import TestClient

from agromind_api.main import app


client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_analyze_returns_all_specialists(monkeypatch) -> None:
    async def no_core_evidence(field):
        return None, None, None

    async def no_external_evidence(*args, **kwargs):
        return None

    async def no_gemini(prompt, image=None):
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


def test_ecosystem_reports_all_agents_and_orchestrator() -> None:
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


def test_source_status_lists_all_authorized_sources() -> None:
    response = client.get("/api/source-status")
    assert response.status_code == 200
    names = {source["name"] for source in response.json()["sources"]}
    assert names == {
        "Open-Meteo",
        "data.gov.in",
        "AGMARKNET",
        "Krishi DSS",
        "Soil Health Card",
    }


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
