"""Local, evidence-linked document extraction for pilot incident reports.

Requires Ollama running locally plus qwen3:8b and ibm/granite-docling. Model output is
candidate evidence only: it is never accepted as measured data or used for calculation.
"""
import argparse
import base64
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen

FIELDS = [
    "event_identity", "observation_time", "temperature", "relative_humidity",
    "precipitation", "wind_speed", "wind_direction", "observed_fire_behavior",
]
FACTS_SCHEMA = {
    "type": "object", "required": ["facts"], "additionalProperties": False,
    "properties": {"facts": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["field", "supporting_quote", "value_as_written", "unit_as_written",
                     "approximate_or_range", "time_as_written"],
        "properties": {
            "field": {"type": "string", "enum": FIELDS},
            "supporting_quote": {"type": "string"},
            "value_as_written": {"type": "string"},
            "unit_as_written": {"type": "string"},
            "approximate_or_range": {"type": "string"},
            "time_as_written": {"type": "string"},
        },
    }}}
}


def pages(path):
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    return [{"page": i + 1, "text": (p.extract_text() or "").strip()}
            for i, p in enumerate(reader.pages)]


def evidence_matches(quote, text):
    """Allow PDF line-wrap whitespace while requiring the quote's words verbatim."""
    def normalize(value):
        value = re.sub(r"(?<=\w)-\s*\n\s*(?=\w)", "", value)
        return " ".join(value.split())
    return bool(quote and normalize(quote) in normalize(text))


def _chat(model, messages, timeout=300):
    body = {"model": model, "messages": messages, "stream": False, "think": False,
            "options": {"num_ctx": 8192, "num_predict": 768}}
    if model == "qwen3:8b":
        body["format"] = FACTS_SCHEMA
    request = Request("http://127.0.0.1:11434/api/chat",
                      data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        result = json.load(response)
    return result["message"]["content"], result.get("model"), result.get("created_at")


def extract(path, out, max_pages=None, transport=_chat, event_id=None, resume=False):
    source_pages = pages(path)
    if max_pages is not None:
        source_pages = source_pages[:max_pages]
    output_path = Path(out)
    source = {"path": str(path), "sha256": _sha(path), "page_count": len(pages(path)),
              "event_id": event_id}
    result = {
        "source": source,
        "model_policy": {"text": "qwen3:8b", "scanned_pages": "ibm/granite-docling",
                         "execution": "local sequential; candidate-only; human review required"},
        "document_extraction_candidates": [], "visual_ocr_pages_pending": [],
        "model_errors": [], "processed_pages": [],
    }
    if resume and output_path.exists():
        previous = json.loads(output_path.read_text())
        if previous.get("source") != source:
            raise ValueError("Cannot resume: source document or event identity changed")
        result = previous
    processed = set(result["processed_pages"])

    def checkpoint():
        output_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = output_path.with_suffix(output_path.suffix + ".tmp")
        temporary.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        temporary.replace(output_path)

    for page in source_pages:
        if page["page"] in processed:
            continue
        text = page["text"]
        if len(text) < 160:
            try:
                image = _render_page(path, page["page"])
                visual_text, model, created = transport("ibm/granite-docling", [{
                    "role": "user", "content": "Transcribe the readable text and tables on this report page. "
                    "Preserve numbers, units, dates, table row/column structure and uncertainty as printed. "
                    "Return only the transcription as plain text. Do not summarize or infer. "
                    "If the page is unreadable, return an empty string.",
                    "images": [base64.b64encode(image).decode("ascii")]
                }])
                result["visual_ocr_pages_pending"].append({
                    "page": page["page"], "model_revision": model or "ibm/granite-docling",
                    "model_created_at": created, "ocr_text": visual_text,
                    "review_status": "pending"})
                text = visual_text
            except (OSError, ValueError, RuntimeError) as error:
                result["model_errors"].append({"page": page["page"], "model": "ibm/granite-docling",
                                                "error": str(error), "quality_flag": "ocr_failed"})
                text = ""
            if len(text) < 40:
                if result["visual_ocr_pages_pending"] and result["visual_ocr_pages_pending"][-1]["page"] == page["page"]:
                    result["visual_ocr_pages_pending"][-1]["quality_flags"] = ["ocr_output_too_short"]
                result["model_errors"].append({
                    "page": page["page"], "model": "ibm/granite-docling",
                    "error": "OCR returned fewer than 40 characters",
                    "quality_flag": "ocr_output_too_short",
                })
                result["processed_pages"].append(page["page"])
                processed.add(page["page"])
                checkpoint()
                print(f"page {page['page']}/{len(source_pages)}: OCR unavailable", flush=True)
                continue
        # The report text is kept bounded and page-local so evidence page identity survives.
        prompt = (
            "Extract only explicitly stated facts from this single official wildfire-report page. "
            "Return JSON with a facts array. Each fact must include field, a verbatim supporting_quote, "
            "value_as_written, unit_as_written, approximate_or_range, time_as_written. "
            "Use only fields from this exact list: " + ", ".join(FIELDS) + ". "
            "The supporting_quote must be copied exactly from the page text. "
            "Do not calculate, infer, convert, "
            "resolve ambiguity, or combine statements. Return an empty array if none. Page number: "
            + str(page["page"]) + "\nSOURCE TEXT:\n" + text[:18000]
        )
        content = ""
        try:
            content, model, created = transport("qwen3:8b", [{"role": "user", "content": prompt}])
            parsed = json.loads(content)
        except (OSError, ValueError, TimeoutError, TypeError) as error:
            result["model_errors"].append({
                "page": page["page"], "model": "qwen3:8b", "error": str(error),
                "raw_response": content[:2000] if content else None,
                "quality_flag": "structured_output_parse_failed",
            })
            result["processed_pages"].append(page["page"])
            processed.add(page["page"])
            checkpoint()
            print(f"page {page['page']}/{len(source_pages)}: structured output invalid", flush=True)
            continue
        for fact in parsed.get("facts", []):
            quote = fact.get("supporting_quote", "")
            allowed_field = fact.get("field") in FIELDS
            fact["page"] = page["page"]
            fact["event_id"] = event_id
            fact["source_document"] = Path(path).name
            fact["model_revision"] = model or "qwen3:8b"
            fact["model_created_at"] = created
            fact["review_status"] = "pending"
            fact["evidence_valid"] = bool(allowed_field and evidence_matches(quote, text))
            if not fact["evidence_valid"]:
                fact["candidate_value"] = None
                fact["quality_flags"] = [
                    flag for flag, invalid in (
                        ("unsupported_field_name", not allowed_field),
                        ("supporting_quote_not_exact_page_substring", not evidence_matches(quote, text)),
                    ) if invalid
                ]
            else:
                fact["candidate_value"] = fact.get("value_as_written")
                fact["quality_flags"] = []
            result["document_extraction_candidates"].append(fact)
        result["processed_pages"].append(page["page"])
        processed.add(page["page"])
        checkpoint()
        print(f"page {page['page']}/{len(source_pages)}: "
              f"{len(result['document_extraction_candidates'])} candidates", flush=True)
    return result


def _render_page(path, page_number):
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(path))
    bitmap = document[page_number - 1].render(scale=1.5)
    stream = __import__("io").BytesIO()
    bitmap.to_pil().save(stream, format="PNG")
    return stream.getvalue()


def pending_measurement(candidate, source, event_id, interval_id, spatial_support):
    """Map a candidate to the shared sidecar shape; review is always pending."""
    exact_quote = candidate.get("supporting_quote", "")
    linked = bool(candidate.get("evidence_valid") and exact_quote and candidate.get("page"))
    return {
        "field": candidate.get("field", "document_fact"),
        "value": candidate.get("candidate_value") if linked else None,
        "unit": candidate.get("unit_as_written"), "kind": "document_extracted",
        "source": {"id": source.get("path"), "version": candidate.get("model_revision"),
                   "sha256": source.get("sha256"), "event_id": event_id,
                   "independence_group": "official_incident_document"},
        "original": {"value_as_written": candidate.get("value_as_written"),
                     "unit_as_written": candidate.get("unit_as_written"),
                     "approximate_or_range": candidate.get("approximate_or_range")},
        "time_window": {"start": None, "end": None,
                        "source_time_as_written": candidate.get("time_as_written"),
                        "convention": "report wording; normalized interval requires review"},
        "spatial_support": {"kind": "document_context", **spatial_support},
        "method": "Local LLM candidate; exact passage/page retained; no calculation or inference",
        "quality_flags": list(candidate.get("quality_flags", [])) +
                         ([] if linked else ["evidence_link_missing"]),
        "evidence": [{"document": source.get("path"), "sha256": source.get("sha256"),
                      "page": candidate.get("page"), "passage": exact_quote,
                      "model_revision": candidate.get("model_revision")}],
        "review_status": "pending", "conflicts": [],
        "interval_id": interval_id,
    }


def _sha(path):
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-pages", type=int)
    parser.add_argument("--event", help="Known event ID; interval linkage still requires review")
    parser.add_argument("--resume", action="store_true", help="Resume matching source/event checkpoints")
    args = parser.parse_args()
    result = extract(args.document, args.output, args.max_pages,
                     event_id=args.event, resume=args.resume)
    print(json.dumps({"candidates": len(result["document_extraction_candidates"]),
                      "ocr_pages_pending": len(result["visual_ocr_pages_pending"])}))


if __name__ == "__main__":
    main()
