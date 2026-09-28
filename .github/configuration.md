# GitHub configuration

The [frontend workflow](workflows/frontend.yml) is configured for pushes and pull
requests touching `frontend/**` or the workflow itself. It uses Node.js 24 and runs
installation, typechecking, tests, build and an offline API smoke check. Live source
retrieval and Python historical/LLM/vision checks are not covered by this workflow.
Workflow configuration alone does not establish a passing run or required branch gate.

[Bug](ISSUE_TEMPLATE/bug_report.yml) and [data/evidence](ISSUE_TEMPLATE/data_evidence.yml)
issue forms and a [PR template](pull_request_template.md) are provided. They do not
create issues, assign reviewers, configure labels or contact contributors.

Maintainer follow-ups before a public contributor launch:

- Confirm repository visibility, Issues/Discussions availability and useful labels.
- Agree component reviewers before adding `CODEOWNERS`; no named ownership is assumed.
- Decide required checks and branch protection in GitHub settings.
- Review source-specific redistribution and attribution for tracked datasets/examples.
- Add credential-free Python research CI as a separate scoped change if desired.

GitHub settings, branch protections, notifications and review response times were
not verified by this documentation audit. See [CONTRIBUTING](../CONTRIBUTING.md).

Research contributors can use the [study proposal form](ISSUE_TEMPLATE/research_proposal.yml)
and [research contribution guide](../research/CONTRIBUTING.md). The form does not
assign reviewers or automatically approve a study.
