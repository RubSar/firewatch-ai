# Contributing research

Follow the [general contribution guide](../CONTRIBUTING.md) for repository setup and
conduct. A research contribution can be a proposed protocol, a reproduction, a
source audit, a documented failure or a review; it need not change the application.

## Start a study

1. Check the [study index](README.md) and existing issues/PRs for overlap. For substantial
   work, open a research-proposal issue describing one question, affected components,
   required data and a measurable deliverable. No issue is required for a small correction.
2. External contributors can fork the repository and open a PR against `main`. Follow
   your checkout's workflow; the maintainer's local main-only convention is in
   [AGENTS.md](../AGENTS.md). Contributors do not need direct upstream push access.
3. From the repository root, copy the template into an unused descriptive folder:

   ```sh
   cp -R research/templates/study research/studies/your-study-name
   ```

   Replace `your-study-name` with a short lowercase hyphenated name and first check
   that the destination does not exist. Fill in all template fields or mark them
   explicitly unknown/not applicable. Add the study to the index.
4. Record the question and evaluation method before tuning. Preserve dated protocol
   amendments and distinguish exploratory analysis from held-out evaluation.
5. Submit the protocol or evidence as a focused PR. Describe commands actually run,
   open questions, source rights, affected contracts and the review you need.

## What a reviewable study contains

- **README:** status/date, contributors, research question, scope, artifact links and
  review history. Do not invent a reviewer or list an assistant as independent review.
- **Protocol:** event/time/geographic scope, data sources and terms, measurement
  definitions, methods, baselines if applicable, exclusions, uncertainty and acceptance
  criteria. Distinguish observation, reconstruction, simulation and assumptions.
- **Findings:** actual results, failures, sample sizes before/after filtering,
  limitations and the conclusions the evidence supports. Proposed work has no results.
- **Reproduction:** code revision, dataset versions/hashes, environment/lockfile,
  working directory, commands, seeds, expected artifacts and access/hardware needs.
  A notebook should run in order in a clean kernel without hidden state. Clear secrets,
  private data and bulky outputs before committing it.

Keep reusable code in the established component and link to it. Study-only scripts
or notebooks can live beside the protocol with their own dependency instructions
and relevant checks. Small original summaries/plots and permitted fixtures can be
tracked; large datasets/weights cannot. Record external artifact URLs and checksums
without committing signed URLs, credentials or private operational information.

Use the [data contribution checklist](../docs/research-data/contributing.md) for
units, CRS, source evidence, missingness and review. Unknown suppression is not zero
suppression. A monthly or final extent is not an hourly target. Inputs based on the
realized burned footprint cannot establish prospective forecast accuracy.

## Review and status changes

Use the statuses defined in the [index](README.md). For `reviewed`, record who
reviewed, the date, evidence/PR link, review scope and unresolved issues. Software,
reproducibility and domain reviews are different; label which occurred. Merging a
PR or passing tests alone does not justify a scientific-validation claim.

Reviewers should check whether the question matches the method, evidence is
traceable, reproduction is possible or its blockers explicit, exclusions and failed
runs are retained, and conclusions respect uncertainty. Domain reviewer assignments
are currently open; do not promise review timelines or operational approval.

Documentation-only PRs need a link/content check. Executable changes need relevant
component or study checks; report skipped network/model work. Existing frontend CI
does not run every research study. Public release of datasets still requires a
source-specific terms review, including for derived JSON and examples.
