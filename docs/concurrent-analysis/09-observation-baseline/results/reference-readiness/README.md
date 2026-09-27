# Infrared reference readiness evidence

[Research findings](../../reference-readiness.md): 21 acquired IR perimeters, 16 valid
geometries, zero covering Sentinel groups within the provisional six-hour screen.
No model evaluation, tuned threshold or accepted human labels are produced.

## Files and attribution

- `source-manifest.json`: original bounded ZIP acquisition, exact source members,
  CRC checks and per-file SHA-256. Full source archive checksum remains unverified.
- `timestamp-registry.json`: explicit publisher timestamps bound to every KML hash.
- `publisher/`: immutable Zenodo release metadata, ZIP inventory, pinned FireBench
  timestamp configuration, Apache code license, data terms and NIFC notice.
- `reference-audit.json`: all 21 accepted/rejected geometry records and endpoint
  diagnostics. Rejected files remain intact in the local source directory.
- `timing-policy.json`, `sentinel-timing-catalog.json`, `timing-screen.json`: policy
  saved before a complete 66-item query, and offline matching results.
- `source-register.json`: retrieval URLs, timestamps and hashes of discovery responses.
  Most raw discovery bodies remain local under ignored component data. The primary
  NIFC notice/index pages are retained in `primary-indexes/`.
- `collector/`: historical acquisition/registration source snapshots for manifest
  code hashes. These were staging scripts with staging-relative paths; use the
  component commands below for supported reproduction. They are not imported by
  the application. No third-party executable was run.

Original observations: U.S. Forest Service NIROPS aerial IR mapping. Curated KMLs and
timestamp assignment: FireBench/Wildfire Interdisciplinary Research Center at SJSU,
Costes and Kochanski, with Farguell and Selvaraj, dataset
[DOI 10.5281/zenodo.20279621](https://doi.org/10.5281/zenodo.20279621), version 2026.2.
Keep the supplied notices and data-specific terms; do not relabel source data as
Apache-licensed merely because the source code uses that license.

## Reproduce locally

From `backend/vision`, with optional `requirements-satellite.txt` installed:

```powershell
$result = '../../docs/concurrent-analysis/09-observation-baseline/results/reference-readiness'
python audit_ir_reference.py data/caldor-ir-v2026.2 "$result/timestamp-registry.json" --output runs/caldor-ir-replay-new
python match_ir_scenes.py "$result/timing-policy.json" "$result/reference-audit.json" runs/caldor-ir-replay-new/perimeters.geojson "$result/sentinel-timing-catalog.json" --output runs/caldor-timing-replay-new.json
python -B -m unittest discover -s tests -v
```

Every output path must be fresh. Compare the reproduced geometry byte hash and
report `perimeters`, `endpoint_changes` and `counts` with the original audit. In
timing results compare `matches` and `reference_count_by_gap_hours`. Run timestamps
differ legitimately. The original timing policy binds the **original audit report**
hash, so the timing command deliberately uses that report with reproduced geometry.

Raw KMLs are local and ignored at `backend/vision/data/caldor-ir-v2026.2/`.
Derived GeoJSON/replays are under `backend/vision/runs/reference-readiness/`.
If pixels/files are absent on a different checkout, re-acquire this exact public
subset (no account, no full 697 MB archive download):

```powershell
python fetch_ir_reference.py "$result/source-manifest.json" --output data/caldor-ir-reacquired
python audit_ir_reference.py data/caldor-ir-reacquired "$result/timestamp-registry.json" --output runs/caldor-reacquired-audit
```

The re-acquirer refuses changed source sizes/hashes, unsafe paths, ignored Range
headers or excessive reads. It verifies all selected members, retains the original
manifest bytes for the registry, and records new retrieval details separately in
`reacquisition.json`. It never treats the historical retrieval time as the new one.
Network availability can change. The final audit/matcher need no network.

Preserve the original six-hour screen and all failures. Publisher-curated UTCs,
nearby captures or valid polygons do not independently establish time-matched
burned-pixel truth. See [the contract](../../../../../contracts/research/ir-reference.md).
