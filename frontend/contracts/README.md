# @firewatch/contracts

Shared provider and wire types plus the runtime binary encode/decode implementation.
The package performs no network I/O.

| File | What |
|---|---|
| `src/providers.ts` | the ARCHITECTURE.md §9 ports, plus `Provenance` / `Provided<T>` |
| `src/wire.ts` | REST DTOs, commands, server events |
| `src/codec.ts` | binary encode/decode for the state channel |

Both the browser and the API import these, so a change here is a change to both.

**The codec must agree byte for byte on both sides.** A drift is silent — it
renders as a corrupted fire rather than an error — so change `encode*` and
`decode*` together and re-run `npm run smoke:api`, which round-trips every frame
type against a client-side mirror.

`Provided<T>` requires provenance fields alongside data. Types enforce the shape,
not the truth of source labels: adapters, tests and reviewers must check meaning,
units, coverage and fallback behavior.

The repository-root [contracts](../../contracts/README.md) define language-neutral
historical and observation-research formats. This package defines the separate
TypeScript simulation protocol. Run `npm run smoke:api` from `frontend/` after
codec changes; also run the root workspace type checks and tests.
