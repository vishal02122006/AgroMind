"""Check specialist prompt contracts offline or evaluate live Gemini responses."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from agromind_api.main import gemini


def build_prompt(case: dict) -> str:
    agent = case["agent"]
    field = case["field"]
    context = "; ".join(f"{key}={value}" for key, value in field.items())
    return (
        f"You are the independent {agent} Agent. "
        f"Input: {context}. "
        "Use only the supplied evidence, label uncertainty, do not invent measurements, "
        "and require local expert verification for consequential advice. "
        f"Answer briefly and include: {', '.join(case['required'])}. "
        "Do not use any of these phrases: "
        f"{', '.join(case['forbidden'])}."
    )


def prompt_contract_passes(case: dict, prompt: str) -> bool:
    lowered = prompt.casefold()
    required_rules = (
        "use only the supplied evidence",
        "label uncertainty",
        "do not invent measurements",
        "require local expert verification for consequential advice",
        "answer briefly and include:",
        "do not use any of these phrases:",
    )
    field_context = all(
        f"{key}={value}".casefold() in lowered
        for key, value in case["field"].items()
    )
    required_terms = all(term.casefold() in lowered for term in case["required"])
    forbidden_terms = all(term.casefold() in lowered for term in case["forbidden"])
    return (
        f"you are the independent {case['agent']} agent.".casefold() in lowered
        and all(rule in lowered for rule in required_rules)
        and field_context
        and required_terms
        and forbidden_terms
    )


async def evaluate(live: bool, data_file: Path) -> int:
    cases = json.loads(data_file.read_text(encoding="utf-8"))
    passed = 0

    for case in cases:
        prompt = build_prompt(case)
        if live:
            answer = await gemini(prompt)
            if answer:
                lowered = answer.lower()
                required_ok = all(term.lower() in lowered for term in case["required"])
                forbidden_ok = all(term.lower() not in lowered for term in case["forbidden"])
                ok = required_ok and forbidden_ok
            else:
                ok = False
            detail = answer or "model returned no text"
        else:
            ok = prompt_contract_passes(case, prompt)
            detail = "offline prompt contract"

        status = "PASS" if ok else "FAIL"
        passed += int(ok)
        print(f"{status} | {case['agent']} | {detail}")

    print(f"\nBenchmark: {passed}/{len(cases)} passed")
    return 0 if passed == len(cases) else 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="Call configured Gemini model")
    parser.add_argument(
        "--data",
        type=Path,
        default=Path(__file__).with_name("agent_benchmark.json"),
    )
    args = parser.parse_args()
    raise SystemExit(asyncio.run(evaluate(args.live, args.data)))


if __name__ == "__main__":
    main()
