import json
from pathlib import Path

from training.evaluate_agents import build_prompt, prompt_contract_passes


def test_offline_prompt_contract_detects_missing_guardrail() -> None:
    data_file = Path(__file__).parents[1] / "training" / "agent_benchmark.json"
    case = json.loads(data_file.read_text(encoding="utf-8"))[0]
    prompt = build_prompt(case)

    assert prompt_contract_passes(case, prompt)
    assert not prompt_contract_passes(
        case,
        prompt.replace("label uncertainty", "claim certainty", 1),
    )
