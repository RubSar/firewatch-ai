"""Score local extraction candidates against a separately reviewed, human-labeled gold set."""
import argparse
import json
from pathlib import Path


def evaluate(gold_path, candidates_path):
    gold = json.loads(Path(gold_path).read_text())
    prediction_doc = json.loads(Path(candidates_path).read_text())
    cases = gold["cases"]
    if len(cases) < 100:
        raise ValueError("The reviewed evaluation set must contain at least 100 fields")
    case_types = {case.get("case_type") for case in cases}
    missing_types = {"absent_fact", "range", "ambiguous_timestamp"} - case_types
    if missing_types:
        raise ValueError(f"Evaluation cases missing required types: {sorted(missing_types)}")
    if gold.get("document_set") == prediction_doc.get("development_document_set"):
        raise ValueError("Prompt-development and evaluation document sets must be separate")
    predicted = prediction_doc["document_extraction_candidates"]
    by_identity = {}
    for candidate in predicted:
        key = (candidate.get("source_document"), candidate.get("page"), candidate.get("field"))
        by_identity.setdefault(key, []).append(candidate)
    tp = fp = fn = unsupported = evidence_linked = unit_correct = time_correct = 0
    expected_count = 0
    for case in cases:
        key = (case["source_document"], case["page"], case["field"])
        options = by_identity.get(key, [])
        expected = case["present"]
        expected_count += int(expected)
        correct = next((p for p in options if p.get("candidate_value") == case.get("value_as_written")
                        and p.get("evidence_valid") and p.get("supporting_quote") == case.get("quote")), None)
        if expected and correct:
            tp += 1
            evidence_linked += 1
            unit_correct += int(correct.get("unit_as_written") == case.get("unit_as_written"))
            time_correct += int(correct.get("time_as_written") == case.get("time_as_written"))
        elif expected:
            fn += 1
        for candidate in options:
            if not expected or candidate is not correct:
                fp += 1
            if not candidate.get("evidence_valid"):
                unsupported += 1
    precision = tp / (tp + fp) if tp + fp else 0
    recall = tp / expected_count if expected_count else None
    linkage = evidence_linked == tp and all(
        p.get("evidence_valid") and p.get("page") is not None for p in predicted
    )
    return {
        "reviewed_field_cases": len(cases), "true_positives": tp, "false_positives": fp,
        "false_negatives": fn, "precision": precision, "recall": recall,
        "unit_correctness": unit_correct / tp if tp else None,
        "time_correctness": time_correct / tp if tp else None,
        "unsupported_claims": unsupported, "evidence_linkage_complete": linkage,
        "automation_gate_passed": precision >= 0.95 and linkage,
        "interpretation": "Candidate extraction quality only; human review remains required.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("gold", type=Path, help="Human-reviewed evaluation cases JSON")
    parser.add_argument("candidates", type=Path, help="LLM candidate extraction JSON")
    args = parser.parse_args()
    print(json.dumps(evaluate(args.gold, args.candidates), indent=2))


if __name__ == "__main__":
    main()
