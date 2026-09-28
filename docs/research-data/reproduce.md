# Reproduce the historical data workflow

Run commands from the repository root unless the block says otherwise. Python
3.11+, `uv` and `curl` are needed for this workflow. Node.js 24+ is needed only for
the web application. A normal frontend contribution needs neither raw research
files nor Earth Engine access. Start with [CONTRIBUTING](../../CONTRIBUTING.md).

## Install optional research dependencies

```sh
cd backend/api
uv sync --frozen --extra research
uv run --frozen --extra research pytest -q tests/historical_fire
```

All remaining Python commands below run from `backend/api/`. The pinned environment
is [pyproject.toml](../../backend/api/pyproject.toml) plus [uv.lock](../../backend/api/uv.lock).
Keep downloads and credentials out of Git. Use a fresh run directory to preserve
existing results; examples use `.research-data/reproduction/`.

## Obtain the correct GOFER source

From the [v0.2 Zenodo record](https://zenodo.org/records/14642378), download the
publisher's `GOFER.zip`, retain its license/citation, and save it as
`.research-data/GOFER-v02.zip`. Do not overwrite a different local version.
Verify against the audit and extract only the Combined summary:

```sh
uv run --frozen --extra research python - <<'PYGOFER'
from pathlib import Path
import hashlib, zipfile
archive = Path('.research-data/GOFER-v02.zip')
expected = '96eca2e18529eb274ca94af9a730bcf1c9c6da597fb04a9b5cf9167aada451c2'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected, 'Archive version differs'
with zipfile.ZipFile(archive) as z:
    raw = z.read('GOFER/GOFER_Combined/GOFERC_summary.csv')
assert hashlib.sha256(raw).hexdigest() == '2db846c1fbfec1af858dcf244f9b1f88405b49ab9b101c3a27991b4f3315e3d3'
output = Path('.research-data/GOFERC_summary.csv')
if output.exists():
    assert output.read_bytes() == raw, 'Existing summary differs; preserve it'
else:
    output.write_bytes(raw)
PYGOFER
```

If a publisher has changed the file, stop and document the new version/checksum;
do not change the pin merely to make verification pass. The archive contains
shapefile components used directly by enrichment and export, so keep it intact.

## Import daily and hourly situations

```sh
uv run --frozen --extra research python -m historical_fire \
  --download --data-dir .research-data/cfsds-v1.1 \
  --gofer .research-data/GOFERC_summary.csv \
  --output .research-data/reproduction/quality
```

`--download` acquires the 20 pinned CFSDS ZIPs only. Omit it for a cached offline
rerun; hashes are still verified. `--gofer` is optional. Inspect the generated
`data-quality.json`, source/runtime manifests and normalized JSONL. Daily/hourly
outcomes stay separate. Counts should be compared to the [audit](audit-2026-09-28.json),
not the original publication's older release counts.

Do not use the existing `.research-data/results/` directory for a default data-only
run: it contains comparison artifacts and the runner rejects that ambiguity.
`--run-comparisons` explicitly enables the older retrospective experiment; it is
not required for collection or UI preview. Use a separate output directory for it.

## Enrich the three GOFER pilots

Follow [Earth Engine authentication guidance](https://developers.google.com/earth-engine/guides/auth)
with your own authorized project. Authentication and project registration are
separate from obtaining data rights. Store credentials locally, never in JSON
examples or commits. Replace the placeholder project ID below.

```sh
uv run --frozen --extra research earthengine authenticate
uv run --frozen --extra research python -m historical_fire.enrichment_run \
  --archive .research-data/GOFER-v02.zip \
  --summary .research-data/GOFERC_summary.csv \
  --output .research-data/reproduction/pilot \
  --project YOUR_EARTH_ENGINE_PROJECT
uv run --frozen --extra research python -m historical_fire.enrichment_nasa \
  --data-dir .research-data/reproduction/pilot \
  --project YOUR_EARTH_ENGINE_PROJECT
```

The base runner defaults to the three pilot fires and 72 hours each. Add
`--event gofer:2020:Creek` to its command for a Creek-only first run. NASA enrichment
processes the full interval files it finds in that output directory.

**Order matters:** the base runner rewrites sidecars and simple previews. Rerunning
it over NASA-enriched files removes those additions. Prefer a fresh run folder,
then base enrichment, then NASA. NASA saves `intervals-before.json` under a hash-keyed
raw cache; keep that backup. It updates only full `intervals.json`, leaving simple
previews and base completeness reports at the earlier stage.

Recompute completeness from current full sidecars by field **and source and spatial
support**, counting nulls. Review raster coverage, date windows, missing footprints,
source disagreements and pending review status. Do not infer success just because
a CLI exits cleanly. This procedure may need network access and EE quota; current
live collection contents may differ from the saved run.

## Acquire the two NIFC snapshots, then build a candidate preview

```sh
uv run --frozen --extra research python -m historical_fire.nifc \
  --data-dir .research-data/reproduction/nifc \
  --project YOUR_EARTH_ENGINE_PROJECT
uv run --frozen --extra research python -m historical_fire.export_preview \
  --data-dir .research-data/reproduction/pilot \
  --archive .research-data/GOFER-v02.zip \
  --nifc-dir .research-data/reproduction/nifc \
  --output .research-data/reproduction/historical-pilot.json
```

NIFC targets are currently fixed to two incident identifiers in `nifc.py`. A fresh
query may differ from the 2026-09-26 snapshot, or no longer contain those records.
An existing `raw/source.geojson` and its retrieval manifest are reused after a hash
check. Omit `--project` for metadata-only collection; this does not generate weather.
Omit `--nifc-dir` from the exporter for a GOFER-only preview.

Validate the candidate against
[historical-preview.schema.json](../../contracts/historical-preview.schema.json).
Compare interval IDs, source hashes, nulls and geometry with the full sidecars,
then review redistribution terms before intentionally replacing
`frontend/public/data/historical-pilot.json`. Run the frontend checks documented in
[CONTRIBUTING](../../CONTRIBUTING.md) and visually inspect `/history` after replacement.
The preview is simplified for display; use full source geometry for scientific checks.

## Documents and offline checks

Use [the LLM module guide](../../backend/llm/README.md) for PDF extraction and its
100-case evaluation contract. Download reports separately and record publisher URL,
actual retrieval URL, date and hash. Local model setup is optional; extraction is
not part of the normal structured-data commands. No candidate should be treated as
an accepted measurement until a human has reviewed its quoted evidence and time.

```sh
uv run --frozen --extra research pytest -q tests/historical_fire
uv run --frozen --extra research ruff check historical_fire tests/historical_fire
```

Tests cover units, interval alignment, missing data, source separation and geometry
handling; passing software tests does not validate a physical forecast. Report the
commands actually run and skipped network/model work. Keep immutable source files,
source checksums, code revision and raw responses so others can inspect a result
without repeating the live requests.
