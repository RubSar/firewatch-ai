# FireWatch research

A place to propose, reproduce and review wildfire studies. Researchers can contribute
protocols, notebooks, experiments, negative results and domain review through pull
requests. A merged study is not automatically scientifically validated or suitable
for emergency-response decisions.

Start with the [research contribution guide](CONTRIBUTING.md), copy the
[study template](templates/study/README.md), or build on the historical-data example.
No particular editor, assistant or institutional affiliation is required.

## Study index

| Study | Status | Evidence and next step |
| --- | --- | --- |
| [Historical data quality](studies/historical-data-quality/README.md) | awaiting review | Existing acquisition and 2026-09-28 audit documented; independent measurement review and source-rights checks remain open |
| [Suppression effects](studies/suppression-effects/README.md) | proposed | Define evidence-backed intervention timelines; no verified untreated cohort exists |
| [Fire-spread validation](studies/fire-spread-validation/README.md) | proposed | Design evaluation with time-aligned inputs and explicit intervention limitations; no new evaluation was run for this proposal |

Statuses: **proposed** (question/protocol), **in progress** (work underway),
**awaiting review** (evidence submitted with open review), **reviewed** (named,
dated review with a recorded scope). Optional **archived** marks superseded work.
A reviewed study may still have negative results or unresolved limitations. Keep
status, review scope and findings consistent in the index and study README.

## Directory boundaries

```text
research/
├── README.md
├── CONTRIBUTING.md
├── templates/
│   └── study/                 # Copyable README, protocol and findings template
└── studies/
    ├── historical-data-quality/
    ├── suppression-effects/
    └── fire-spread-validation/
```

Each study owns its question, protocol and findings. Add `notebooks/`, `scripts/`
and small `results/` artifacts only when needed. Record dependencies and commands
for study-specific code; there is no shared research environment or universal runner.
Reusable acquisition/model processing remains in `backend/`, simulation code in
`frontend/sim/`, shared schemas in `contracts/`, and application setup/architecture
in `docs/`. Link to these components instead of duplicating implementations.

Large datasets, imagery and weights belong in ignored local storage or separately
versioned external dataset storage. Commit source manifests, hashes, acquisition
instructions and small permitted examples. The bundled history JSON remains in
`frontend/public/data/`; this directory does not replace the application's data path.

## Existing research and migration

The [original historical-data phase](studies/historical-data-quality/protocol.md)
is the first migrated protocol. Its old path remains a forwarding page. The study
links to current acquisition docs and dated findings without duplicating them.

Other [dated investigations](../docs/concurrent-analysis/README.md), including
observation/vision work and older analog comparisons, remain at their existing paths.
The [historical source inventory](../docs/research-data/README.md) stays the shared
data guide. Migrate further studies individually: preserve dates and evidence,
update incoming and relative links, and leave a forwarding page where useful.
Keep competitor/background analysis and project decisions in their existing docs.

See [MIT license scope](../LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md).
Publishing a study does not relicense its data, imagery, quotations or model assets.
