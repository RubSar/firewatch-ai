# Historical data and Python API research

`historical_fire/` contains acquisition, normalization, enrichment and static
historical-preview export tools. Its ignored `.research-data/` directory is a local
cache, not a required download for every contributor or a runtime database.

- [Current inventory, sources and consumers](../../docs/research-data/README.md)
- [Environment setup and reproducible commands](../../docs/research-data/reproduce.md)
- [Data contribution guide](../../docs/research-data/contributing.md)
- [Previous experiment protocols and findings](../../docs/concurrent-analysis/09-historical-similarity/README.md)

No executable general-purpose HTTP API is present in this Python component. The
package name and web dependencies in `pyproject.toml` are legacy metadata; do not
infer a runnable FastAPI service from them. Use the CLI commands in the reproduction
guide for current work.

The optional `research` extra and `uv.lock` pin the Python workflow; tests are under
`tests/historical_fire/`. Shared schemas and examples are under
[`contracts/`](../../contracts/). Document extraction belongs in
[`backend/llm/`](../llm/README.md). The separate TypeScript simulation API is under
[`frontend/api/`](../../frontend/api/README.md).
