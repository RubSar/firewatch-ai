# Frozen satellite transfer evidence

See [the measured research report](../../satellite-transfer.md).
[summary.json](summary.json) records two attempts, one coverage pass and zero
time-matched validations. These are fixed-rule development results, not ML accuracy.

- `cohort-policy*.json`: original and amended selection policy.
- `cohort-v1/`: full candidate decision log and exact selected configs/snapshots.
- `evidence/`: raw public-source responses, request provenance, reference audits,
  origin and spectral diagnostics, amendment, and replay verification.
- `cases/rawlins/`: single-tile catalogue, acquisition metadata, report and overview.
- `cases/county-rd169/`: same-datatake mosaic catalogue, acquisition metadata,
  report, overview, and retained failed single-tile catalogue.
- `initial-single-tile-run-status.json`: historical status before mosaic support;
  the County failure there is superseded by the evaluated case in `summary.json`.

Acquisition directories here contain JSON only. Their crop paths are relative to
the original acquisition directory, whose native GeoTIFFs remain ignored under
`backend/vision/data/satellite-transfer/<incident UUID>/`. Generated raster outputs
are under `backend/vision/runs/satellite-transfer/`. `replay-report.json` records a
second offline evaluation; run timestamps and report SHA-256 naturally differ,
while output hashes and numerical values agree. No external model code was run.

The 130-feature raw candidate response is stored losslessly as gzip to reduce
repository size. `evidence/compression.json` binds compressed and decompressed
SHA-256 values. The request sidecar hashes the **decompressed raw source bytes**.
Other provenance paths are relative to `evidence/`. The failed FTP request is
recorded in `source-probes.json`; it has no downloaded response file.

## Offline reproduction

Install the optional satellite requirements in an isolated environment first.
From `backend/vision`, PowerShell examples (use fresh output paths):

```powershell
$result = '../../docs/concurrent-analysis/09-observation-baseline/results/satellite-transfer'
$cypress = '../../docs/concurrent-analysis/09-observation-baseline/results/cypress-creek-wfigs-snapshot.json'
python perimeter_reference.py audit "$result/evidence/cypress-daily.json" 8432b888-2a01-4825-8eb6-c74589de24fc $cypress --output runs/cypress-history-new.json
python satellite_case.py evaluate "$result/cases/rawlins/catalog" data/satellite-transfer/d05cf942-a3e3-425d-bfe1-0c994ec8956a/acquisition --output runs/rawlins-new
python satellite_mosaic.py evaluate "$result/cases/county-rd169/catalog" data/satellite-transfer/84284851-f0f8-4253-b5bc-da7771e0150d/mosaic-acquisition-v1 --output runs/county-new
python -B -m unittest discover -s tests -v
```

For selection replay, decompress `evidence/transfer-candidates-v2.json.gz` to
`data/satellite-transfer/transfer-candidates-v2.json` with a gzip-capable tool and
verify its SHA-256 against `compression.json`. Then:

```powershell
python perimeter_reference.py select data/satellite-transfer/transfer-candidates-v2.json "$result/cohort-policy-v2.json" cypress-creek-config.json $cypress --output runs/transfer-selection-new
```

Compare selected incident IDs and exact config/snapshot hashes with
`cohort-v1/selection.json`; newly generated report timestamps will differ. The
selection occurred before inspecting new imagery. The spectral diagnostics are
explicitly post-hoc and must not be mistaken for selection criteria.

## Re-acquiring remote crops

If original local pixels are unavailable, use the frozen catalogues rather than
re-running a mutable search. This requires public HTTPS access, without credentials:

```powershell
python satellite_case.py acquire "$result/cases/rawlins/catalog" --output data/rawlins-reacquired
python satellite_mosaic.py acquire "$result/cases/county-rd169/catalog" --output data/county-reacquired
```

Evaluate using these new acquisition directories and compare crop hashes with the
retained manifests. Remote assets or availability can change; a new download is
not automatically the original experiment. Full COG asset hashes were not verified
by window reads. No network is required to evaluate already retained local crops.
