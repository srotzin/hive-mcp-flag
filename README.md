# hive-mcp-flag

[![srotzin/hive-mcp-flag MCP server](https://glama.ai/mcp/servers/srotzin/hive-mcp-flag/badges/score.svg)](https://glama.ai/mcp/servers/srotzin/hive-mcp-flag)

**Feature flag service for the A2A network — Hive Civilization.** DID-keyed targeting, percentage rollouts, x402 USDC settlement on Base L2. MCP `2024-11-05`. Inbound only.

Disable a runaway behavior, gate a new tool behind a DID-prefix canary, or ramp a config change to 25% of agents — without redeploying the agent. LaunchDarkly-shaped semantics, agent-native primitives.

```
brand : Hive Civilization gold #C08D23 (Pantone 1245 C)
spec  : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0
wallet: W1 MONROE 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e (Base)
```

## Quick start

```bash
git clone https://github.com/srotzin/hive-mcp-flag
cd hive-mcp-flag
npm install
npm start
# hive-mcp-flag on :3000
```

Hosted endpoint: `https://hive-mcp-flag.onrender.com/mcp`

## Tools and pricing

| Tool | USD / call | Notes |
|---|---|---|
| `flag_eval`     | $0.0005 | Evaluate a flag for a DID; returns resolved value and matched rule. |
| `flag_list`     | free    | List flags owned by a DID. |
| `flag_describe` | free    | Full flag definition and recent evaluations. |
| `flag_create`   | $0.001  | Create a flag with default value and targeting rules. |
| `flag_update`   | $0.0005 | Update default value or targeting rules. Owner-only. |
| `flag_delete`   | $0.001  | Tombstone a flag. Owner-only. |

All payments are inbound. Submit a Base USDC `tx_hash` (caller → W1) in the request body or `x402-tx-hash` header. The shim reads the receipt from Base RPC, decodes the USDC `Transfer` log, and verifies recipient and amount before serving the call.

## Targeting rules

Rules evaluate in declared order. First match wins. If none match, the flag's `default_value` is returned.

```json
[
  { "type": "did_match",  "dids": ["did:hive:0xabc"], "value": true },
  { "type": "did_prefix", "prefix": "did:hive:",      "value": true },
  { "type": "rollout",    "percent": 25,              "value": true }
]
```

`rollout` uses `SHA256(did + flag_key) mod 100`, so the same `(did, flag_key)` pair always falls in the same bucket — sticky variant assignment with no extra storage.

## REST API

```
POST   /v1/flag/eval                # body: { flag_key, evaluating_did, tx_hash }
GET    /v1/flag/list?owner_did=...
GET    /v1/flag/{name}              # describe
POST   /v1/flag                     # create
PATCH  /v1/flag/{name}              # update — owner-only
DELETE /v1/flag/{name}              # tombstone — owner-only
GET    /v1/flag/today               # revenue snapshot
GET    /health                      # service health
GET    /.well-known/mcp.json        # MCP discovery
POST   /mcp                         # JSON-RPC 2.0
```

## MCP example

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "flag_eval",
    "arguments": {
      "flag_key": "new_routing_v2",
      "evaluating_did": "did:hive:0xabc",
      "tx_hash": "0xBASE_TX_PAYING_$0.0005_USDC_TO_W1"
    }
  }
}
```

## Real rails

| Surface | Library | Behavior |
|---|---|---|
| Persistence | `better-sqlite3` | SQLite at `/tmp/flag.db`, WAL mode, transactional create/update. |
| Signature verification | `ethers.verifyMessage` | Recovers the signer of a message and compares against a claimed address. |
| Payment verification | `ethers.JsonRpcProvider` | Reads tx receipt from Base RPC, decodes USDC `Transfer` logs, asserts `to == W1` and `amount >= asking_usd`. |

Set `VERIFY_ONCHAIN=false` only for local development or testing — the default and the production deployment verify on-chain.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT`              | `3000` | HTTP port |
| `ENABLE`            | `true` | Master switch (`false` to brown-out) |
| `WALLET_ADDRESS`    | W1     | Base L2 receiver |
| `BASE_RPC_URL`      | `https://mainnet.base.org` | RPC for receipt reads |
| `VERIFY_ONCHAIN`    | `true` | Read receipts on Base before serving paid calls |
| `MAX_FLAGS_PER_DID` | `500`  | Per-owner cap |
| `DB_PATH`           | `/tmp/flag.db` | SQLite file |

## Caps

- `MAX_FLAGS_PER_DID = 500`
- Max targeting rules per flag: 50
- Request body limit: 256 KB

## Out of scope (v1.1+)

Flag prerequisites (B depends on A), auto-ramping rollouts, push notifications and change webhooks, multi-environment namespaces, dashboard UI.

Permanently rejected: instruments, predictions, or derivatives based on flag states.

---

Hive Civilization · MIT · [github.com/srotzin/hive-mcp-flag](https://github.com/srotzin/hive-mcp-flag)

## Hive Civilization Directory

Part of the Hive Civilization — agent-native financial infrastructure.

- Endpoint Directory: https://thehiveryiq.com
- Live Leaderboard: https://hive-a2amev.onrender.com/leaderboard
- Revenue Dashboard: https://hivemine-dashboard.onrender.com
- Other MCP Servers: https://github.com/srotzin?tab=repositories&q=hive-mcp

Brand: #C08D23
<!-- /hive-footer -->
