# hive-mcp-flag v1.0.0

**Released:** 2026-04-27
**License:** MIT
**Brand:** Hive Civilization gold #C08D23 (Pantone 1245 C)
**Council provenance:** Tier A position 6

Initial public release. Feature flag service for the A2A network — Hive Civilization. Inbound only, real rails, MCP `2024-11-05`.

## Tools

| Tool | USD / call | Description |
|---|---|---|
| `flag_eval`     | $0.0005 | Evaluate a flag for a DID. Returns resolved value and matched rule. |
| `flag_list`     | free    | List flags owned by a DID. |
| `flag_describe` | free    | Full flag definition and recent evaluations. |
| `flag_create`   | $0.001  | Create a flag with default value and targeting rules. |
| `flag_update`   | $0.0005 | Update default value or targeting rules. Owner-only. |
| `flag_delete`   | $0.001  | Tombstone a flag. Owner-only. |

## REST endpoints

| Method | Path | Purpose |
|---|---|---|
| POST   | `/v1/flag/eval`           | Evaluate a flag for a DID. |
| GET    | `/v1/flag/list`           | List flags by owner DID. |
| GET    | `/v1/flag/{name}`         | Describe one flag. |
| POST   | `/v1/flag`                | Create a flag. |
| PATCH  | `/v1/flag/{name}`         | Update a flag. Owner-only. |
| DELETE | `/v1/flag/{name}`         | Tombstone a flag. Owner-only. |
| GET    | `/v1/flag/today`          | Revenue snapshot. |
| GET    | `/health`                 | Service health. |
| GET    | `/.well-known/mcp.json`   | MCP discovery document. |
| POST   | `/mcp`                    | MCP JSON-RPC 2.0 endpoint. |

## Targeting

- Rule types: `did_match`, `did_prefix`, `rollout`.
- Percentage rollouts are deterministic by `SHA256(did + flag_key) mod 100` — the same `(did, flag_key)` pair always lands in the same bucket.
- Rules evaluate in declared order. First match wins. Otherwise default value is returned.
- Flag value types: `boolean`, `string`, `number`, `json`.

## Real rails

- Persistence: `better-sqlite3`, WAL mode, SQLite file at `/tmp/flag.db`.
- Signature verification: `ethers.verifyMessage` for owner DID claims.
- Payment verification: `ethers.JsonRpcProvider` reads tx receipts from Base RPC, decodes USDC `Transfer` logs, asserts recipient is W1 and amount covers the asking price.
- Settlement asset: USDC on Base L2 (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).
- Wallet: W1 MONROE `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` (read-only verification — 100% inbound, no signing wallet).

## Brand

- Pantone 1245 C / `#C08D23` — verified in landing HTML, `/health`, and `/.well-known/mcp.json`.
- Voice: Stripe Docs — no exclamation, emoji, or superlatives.

## Caps and defaults

- `MAX_FLAGS_PER_DID = 500`
- Max targeting rules per flag: 50
- Request body limit: 256 KB
- `ENABLE=true` default

## Deployment

- Render (oregon, starter), `ENABLE=true` by default, auto-deploy on push to `main`.
- Smithery: `https://smithery.ai/server/srotzin/hive-mcp-flag`

## Out of scope (v1.1+)

Flag prerequisites, auto-ramping rollouts, push webhooks, multi-environment namespaces, dashboard UI. Permanently rejected: instruments, predictions, or derivatives based on flag states.
