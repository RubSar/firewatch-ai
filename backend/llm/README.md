# LLM

Prompts, model integrations, and evaluations belong here.

## Historical incident documents

[`historical_documents.py`](historical_documents.py) extracts candidate facts from one official
incident-report page at a time. It uses local Ollama `qwen3:8b` for text and
`ibm/granite-docling` for image-rendered pages with inadequate text. Run it only after acquiring
the source document:

```sh
python historical_documents.py /path/to/official-report.pdf \
  --event gofer:2020:Creek --output /path/to/review-pending.json
```

Each candidate must include an exact quote and page number. Non-verbatim text is set to null, and
every candidate stays `pending` for review. The model cannot calculate physical quantities,
resolve ambiguous times, or overwrite GOFER records. Keep benchmark documents separate from prompt
development documents and require a reviewed 100-field benchmark before broader automation.

The `--event` value links the report to the incident. Interval linkage is intentionally left for
review when the report time does not unambiguously identify a GOFER hour. Once a separate human-
reviewed evaluation set exists, score it with:

```sh
python historical_document_eval.py /path/to/reviewed-evaluation-cases.json \
  /path/to/candidate-extraction.json
```

The evaluator refuses fewer than 100 cases, missing absent/range/ambiguous-time cases, or reuse of
the prompt-development document set.
