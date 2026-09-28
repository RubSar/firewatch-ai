# Contributing to FireWatch AI

We welcome software fixes, reproducible data audits, documentation and practitioner
review. FireWatch is a research prototype: software correctness and retrospective
agreement do not establish operational forecast accuracy.

## Find a starting point

- Browse [open issues](https://github.com/RubSar/firewatch-ai/issues), particularly
  [good first issues](https://github.com/RubSar/firewatch-ai/labels/good%20first%20issue)
  and [help wanted](https://github.com/RubSar/firewatch-ai/labels/help%20wanted).
- Use [Discussions](https://github.com/RubSar/firewatch-ai/discussions) for questions,
  research ideas and workflow feedback. Use issues for reproducible problems or
  a bounded piece of work with acceptance criteria. If Discussions is unavailable,
  use an issue for a concrete question or proposal.
- Browse the [technical contribution backlog](docs/contributor-strategy.md) for
  scoped proposals; these drafts do not imply assigned reviewers.
- Before a substantial change, comment on the relevant issue with your proposed
  scope, affected component and expected evidence. Check existing PRs for overlap.
  Small corrections can be submitted directly as a PR.

No particular editor, AI assistant, employer or fire-service affiliation is required.
Domain reviewers can contribute without writing code. Component ownership is not
yet formally assigned; do not assume an issue has a named reviewer or response SLA.

## Local setup

External contributors can fork the repository and submit a focused pull request
against upstream `main`. Inspect your checkout and preserve existing changes.
The maintainer's local checkout convention is recorded in [AGENTS.md](AGENTS.md).

For the web application, use Node.js 24+ and npm. From the repository root:

```sh
cd frontend
npm ci
npm run dev:web
```

Open http://localhost:5173 or http://localhost:5173/history. Leave `VITE_API_URL`
unset for browser-only mode. Bundled history can be inspected without acquiring
research datasets; external map tiles and live providers still need connectivity.

On macOS/Linux, `npm run dev` starts both web and simulation API. For separate
terminals or Windows, follow [frontend setup](frontend/README.md); the API command
is `npm run dev:api`, and the web process needs
`VITE_API_URL=http://127.0.0.1:8787` in its environment. Do not commit credentials.

Python research is optional for frontend work. Follow the relevant component:

- [Historical acquisition and enrichment](docs/research-data/reproduce.md)
- [Incident-document extraction](backend/llm/README.md)
- [RGB/thermal and satellite observation research](backend/vision/README.md)

Use an isolated environment and only the dependencies needed for your task. Large
imagery downloads, model weights, Earth Engine and Earthdata access are not general
contribution prerequisites.

## Where changes belong

For protocols, notebooks, reproductions and findings, use the
[research contribution guide](research/CONTRIBUTING.md) and
[study template](research/templates/study/README.md). Studies are submitted through
pull requests; direct upstream push access is not required.

| Component | Scope |
| --- | --- |
| `frontend/src/` | Application UI, historical atlas and map components |
| `frontend/sim/` | Shared simulation kernel and physics checks |
| `frontend/api/` | Simulation API and data providers |
| `frontend/contracts/` | Shared TypeScript simulation/provider interfaces |
| `backend/api/` | Historical acquisition, enrichment and exports |
| `backend/llm/` | Document extraction and its evaluation |
| `backend/vision/` | Offline observation research and tests |
| `contracts/` | Language-neutral historical/research schemas and examples |
| `research/` | New studies, experiment-specific notebooks/scripts, protocols and findings |
| `docs/` | Application setup, shared data guides, decisions and legacy research |

Read the relevant README and [repository instructions](AGENTS.md) first. Contract
changes need producer/consumer updates together, with units, coordinate conventions,
time zones, missing-value behavior and compatibility documented.

## Evidence and data contributions

Read the [historical source and usage register](docs/research-data/README.md) and
[data contribution guide](docs/research-data/contributing.md) for starter tasks,
contract links and acceptance criteria. The local `.research-data` cache is not
included in a clone; bundled preview data supports frontend-only contributions.
Use the data-evidence issue template for source gaps and collection proposals.

- Record source URL, version, retrieval date, redistribution terms and processing
  method. Preserve original values and distinguish observed, reconstructed,
  calculated, assumed and synthetic data.
- Keep event identity, observation time, processing time, units, CRS, resolution
  and spatial footprint explicit. Unknown values remain null; missing suppression
  records do not mean no intervention occurred.
- Retain conflicting sources and quality flags. An edited perimeter timestamp is
  not automatically a fire-observation timestamp. Final burned extent is not an
  hourly progression record.
- Label retrospective inputs and prevent outcomes from entering forecast inputs.
  Keep evaluation incidents separate from development incidents.
- Link extracted document facts to exact passages/pages and retain human review
  status. Automated extraction or an assistant's inspection is not independent
  human review.
- Do not commit credentials, private incident/personnel information, local model
  weights or large source datasets. Use permitted small fixtures or reproducible
  acquisition instructions, retaining publisher notices and checksums.

## Checks and pull requests

For frontend changes, run from `frontend/`:

```sh
npm run typecheck
npm test
npm run build
```

Run relevant smoke checks from the component README when changing the API or UI;
inspect UI changes in a browser. For Python work, use the documented component
tests and the dependencies required for the changed module. State any skipped
optional tests or unavailable data. Documentation-only changes need a content/link
review, not the full application test suite.

In your PR, include:

1. The issue and concrete problem being solved.
2. Changed behavior, affected directories and interface/data implications.
3. Commands actually run, results and material limitations.
4. Screenshots for UI changes or small evidence-linked examples for data changes.

Keep unrelated formatting, generated outputs and dependency updates out of the PR.
Retain uncertainty in reports; synthetic test results are not measured wildfire
performance. AI-assisted contributions are welcome, but the contributor remains
responsible for reviewing code, citations, licenses and results.

## Licensing and conduct

Original project code and documentation use the [MIT License](LICENSE). Submit
original contributions under those terms; only contribute material you have the
right to share. Preserve the licenses and attribution of third-party material; see
[third-party notices and data scope](THIRD_PARTY_NOTICES.md).

Be respectful, critique evidence rather than people, and avoid publishing personal
or sensitive operational details. Questions and research disagreements belong in
the public discussion with sources and clear limitations.
