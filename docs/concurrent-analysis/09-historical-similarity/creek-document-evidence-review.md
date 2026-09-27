# Creek Fire report extraction review

All model outputs below are **pending human review**. This is an evidence-link audit, not a human-verified extraction benchmark. Candidate values are shown for triage only; consult the cited report page and the ignored candidate JSON before accepting or rejecting anything.

## Run summary

- Report: [Forest Service Creek Fire investigation report copy](https://dig.abclocal.go.com/kfsn/PDF/Creek-Fire-Report-of-Investigation.pdf); original Forest Service download endpoint returned HTTP 403. The mirror copy SHA-256 is `53f15659a100f34c3fef47d22033add1f0159339ee5789a749790a64ff3cb44b`.
- Event association: `gofer:2020:Creek`; interval association remains unset until a reviewer verifies time wording against source-defined GOFER intervals.
- Pages processed: 30/30; image pages sent through Granite Docling: 27; short/unusable OCR pages: 5.
- Qwen candidates: 26; candidates with page-linked quotations: 21 (80.8%); candidates without exact evidence link: 5, with candidate value set to null.
- Structured model errors: 1; OCR errors/short outputs: 5.
- No candidate has been accepted. The precision/recall, unit/time correctness and 95% automation gate are not measured: no separate 100-field reviewed gold set exists.

## Candidate review table

| # | Page | Field | Candidate value preview | Evidence link | Review |
|---:|---:|---|---|---|---|
| 1 | 1 | `event_identity` | The Creek Fire originated just south Big Creek drainage, we st of Camp Sierra and north of Huntingto… | page quote linked | pending |
| 2 | 1 | `observation_time` | On September 4, 2020, at approximately 1818 hours | page quote linked | pending |
| 3 | 1 | `observed_fire_behavior` | The Creek Fire burned 379,895 acres, destroyed 853 structures, and damaged an additional 64 structur… | page quote linked | pending |
| 4 | 2 | `event_identity` | Creek Fire | page quote linked | pending |
| 5 | 2 | `observation_time` | September 4, 2020 between 1818 and 1833 hours | page quote linked | pending |
| 6 | 2 | `observed_fire_behavior` | null (unlinked) | failed; value null | pending |
| 7 | 2 | `observed_fire_behavior` | declared contained on December 24, 2020 | page quote linked | pending |
| 8 | 2 | `observed_fire_behavior` | destroyed 853 structures, damaged 64 structures and burned 379,895 acres | page quote linked | pending |
| 9 | 5 | `event_identity` | Creek Fire | page quote linked | pending |
| 10 | 5 | `observation_time` | 0900 hours | page quote linked | pending |
| 11 | 5 | `observed_fire_behavior` | a smoke chimney with a single snag on fire; ember fly from the fire, causing the fire to spread | page quote linked | pending |
| 12 | 12 | `observation_time` | 1630 hours | page quote linked | pending |
| 13 | 12 | `observation_time` | 1630 hours | page quote linked | pending |
| 14 | 12 | `observation_time` | 1630 hours | page quote linked | pending |
| 15 | 21 | `relative_humidity` | 0% RH | page quote linked | pending |
| 16 | 21 | `relative_humidity` | 10% RH | page quote linked | pending |
| 17 | 21 | `relative_humidity` | 18% RH | page quote linked | pending |
| 18 | 21 | `relative_humidity` | 22% RH | page quote linked | pending |
| 19 | 23 | `event_identity` | 20-05-MAMP0J1 | page quote linked | pending |
| 20 | 23 | `observation_time` | September 5, 2020 | page quote linked | pending |
| 21 | 23 | `temperature` | 54,000 | page quote linked | pending |
| 22 | 23 | `relative_humidity` | null (unlinked) | failed; value null | pending |
| 23 | 23 | `precipitation` | null (unlinked) | failed; value null | pending |
| 24 | 23 | `wind_speed` | null (unlinked) | failed; value null | pending |
| 25 | 23 | `wind_direction` | null (unlinked) | failed; value null | pending |
| 26 | 23 | `observed_fire_behavior` | 60%, 6% | page quote linked | pending |

Every supporting quotation, source line and OCR transcription remains in the ignored runtime file `backend/api/.research-data/enrichment-pilot/documents/creek-fire-candidates.json`; the original PDF page is the authority. The checked-in table deliberately does not promote candidate text to historical measurements.
