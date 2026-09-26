# @firewatch/contracts

Shared API schemas, wire protocol and provider ports. Types and codec only — no
runtime logic, no I/O.

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

`Provided<T>` is the load-bearing convention: no provider returns bare data, so
"mock data presented as live" is a type error rather than a judgement call.

This is distinct from the repo-root `contracts/` directory, which is the
cross-team scaffold described in `AGENTS.md` and is not used by this work.
