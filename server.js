#!/usr/bin/env node
/**
 * hive-mcp-flag — Feature flag service for the A2A network.
 *
 * Inbound only. Agents POST flag definitions, evaluate them against their
 * own DID, and roll changes out by percentage or DID-keyed targeting rules
 * without redeploying. Charges per call in USDC on Base L2 via x402.
 *
 * Brand: Hive Civilization gold #C08D23 (Pantone 1245 C).
 * Spec  : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0.
 * Wallet: W1 MONROE 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e (Base L2).
 */

import express from 'express';
import {
  openDb, createFlag, getFlag, updateFlag, deleteFlag, listFlagsByOwner,
  recordEvaluation, getAuditLog, recordRevenue, todayRevenue,
} from './lib/store.js';
import { evaluate, validateRules } from './lib/targeting.js';
import { PRICES, USDC_BASE, envelope, verifyBaseUsdcPayment, verifyOwnerSignature, BOGO } from './lib/x402.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const ENABLE = String(process.env.ENABLE || 'true').toLowerCase() === 'true';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const VERIFY_ONCHAIN = String(process.env.VERIFY_ONCHAIN || 'true').toLowerCase() === 'true';
const MAX_FLAGS_PER_DID = Number(process.env.MAX_FLAGS_PER_DID || 500);
const FLAG_TYPES = ['boolean', 'string', 'number', 'json'];
const BRAND_COLOR = '#C08D23';

openDb();

// ─── x402 inbound metering ────────────────────────────────────────────────
function txFromReq(req) {
  return req.body?.tx_hash || req.headers['x402-tx-hash'] || null;
}

function require402(res, kind, did) {
  const amount = PRICES[kind];
  res.status(402).json({
    error: 'payment_required',
    x402: envelope({ kind, amount_usd: amount, pay_to: WALLET_ADDRESS }),
    note: `Submit tx_hash in body or 'x402-tx-hash' header to retry. Asking ${amount} USDC on Base to ${WALLET_ADDRESS}.`,
    did: did || null,
    bogo: BOGO,
  });
}

async function gateAndCharge({ kind, args, did, tx_hash }) {
  if (!ENABLE) return { ok: false, status: 503, body: { error: 'service_disabled' } };
  const price = PRICES[kind];
  if (price === 0) return { ok: true, billed_usd: 0 };
  if (!tx_hash) return { ok: false, status: 402, body: 'gate' };
  if (VERIFY_ONCHAIN) {
    const v = await verifyBaseUsdcPayment({ tx_hash, pay_to: WALLET_ADDRESS, min_usd: price });
    if (!v.ok) return { ok: false, status: 402, body: { error: 'payment_invalid', reason: v.reason, tx_hash } };
    recordRevenue({ kind, did, flag_key: args.flag_key || null, amount_usd: v.amount_usd, tx_hash, payer: v.payer });
    return { ok: true, billed_usd: v.amount_usd, payer: v.payer };
  }
  recordRevenue({ kind, did, flag_key: args.flag_key || null, amount_usd: price, tx_hash, payer: null });
  return { ok: true, billed_usd: price };
}

// ─── MCP tools ────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'flag_eval',
    description: `Evaluate a flag for a DID and return the resolved value plus which targeting rule matched. Charges $${PRICES.flag_eval} USDC on Base.`,
    inputSchema: {
      type: 'object',
      required: ['flag_key', 'evaluating_did'],
      properties: {
        flag_key: { type: 'string', description: 'Flag identifier.' },
        evaluating_did: { type: 'string', description: 'DID being evaluated. Used for targeting and rollout bucket.' },
        tx_hash: { type: 'string', description: 'Base USDC tx hash that paid the asking amount to the W1 wallet.' },
      },
    },
  },
  {
    name: 'flag_list',
    description: 'List flags owned by a DID. Read-only, no charge.',
    inputSchema: {
      type: 'object',
      required: ['owner_did'],
      properties: {
        owner_did: { type: 'string', description: 'Owner DID whose flags to list.' },
      },
    },
  },
  {
    name: 'flag_describe',
    description: 'Return the full definition of a flag — type, default value, targeting rules, evaluation count. Read-only, no charge.',
    inputSchema: {
      type: 'object',
      required: ['flag_key'],
      properties: {
        flag_key: { type: 'string' },
      },
    },
  },
  {
    name: 'flag_create',
    description: `Create a flag with a default value and targeting rules. Charges $${PRICES.flag_create} USDC on Base.`,
    inputSchema: {
      type: 'object',
      required: ['flag_key', 'owner_did', 'type', 'default_value'],
      properties: {
        flag_key: { type: 'string' },
        owner_did: { type: 'string', description: 'DID that owns the flag and may update or delete it.' },
        type: { type: 'string', enum: FLAG_TYPES },
        default_value: { description: 'Returned when no targeting rule matches.' },
        targeting_rules: { type: 'array', description: 'Ordered rule list. See README for shape.' },
        tx_hash: { type: 'string' },
      },
    },
  },
  {
    name: 'flag_update',
    description: `Update a flag's default value or targeting rules. Owner DID only. Charges $${PRICES.flag_update} USDC on Base.`,
    inputSchema: {
      type: 'object',
      required: ['flag_key', 'owner_did'],
      properties: {
        flag_key: { type: 'string' },
        owner_did: { type: 'string' },
        default_value: { description: 'New default; omit to leave unchanged.' },
        targeting_rules: { type: 'array', description: 'New rules; omit to leave unchanged.' },
        tx_hash: { type: 'string' },
      },
    },
  },
  {
    name: 'flag_delete',
    description: `Tombstone a flag. Owner DID only. Charges $${PRICES.flag_delete} USDC on Base.`,
    inputSchema: {
      type: 'object',
      required: ['flag_key', 'owner_did'],
      properties: {
        flag_key: { type: 'string' },
        owner_did: { type: 'string' },
        tx_hash: { type: 'string' },
      },
    },
  },
];

// ─── Pure handlers (already-paid) ────────────────────────────────────────
function doCreate(args) {
  const { flag_key, owner_did, type, default_value, targeting_rules } = args;
  if (!flag_key || !owner_did || !type) return { error: 'flag_key, owner_did, type required' };
  if (!FLAG_TYPES.includes(type)) return { error: `type must be one of ${FLAG_TYPES.join(', ')}` };
  if (getFlag(flag_key)) return { error: 'flag_key_already_exists' };
  if (listFlagsByOwner(owner_did).length >= MAX_FLAGS_PER_DID) {
    return { error: `owner has reached MAX_FLAGS_PER_DID (${MAX_FLAGS_PER_DID})` };
  }
  const v = validateRules(targeting_rules || [], type);
  if (!v.ok) return { error: v.reason };
  const flag = createFlag({ flag_key, owner_did, type, default_value, targeting_rules: targeting_rules || [] });
  return { ok: true, flag };
}

function doEval(args) {
  const { flag_key, evaluating_did } = args;
  if (!flag_key || !evaluating_did) return { error: 'flag_key, evaluating_did required' };
  const flag = getFlag(flag_key);
  if (!flag) return { error: 'flag_not_found' };
  const r = evaluate({ flag, did: evaluating_did });
  recordEvaluation({
    flag_key,
    evaluating_did,
    resolved_value: r.resolved_value,
    targeting_rule_matched: r.targeting_rule_matched,
  });
  return {
    ok: true,
    flag_key,
    evaluating_did,
    resolved_value: r.resolved_value,
    targeting_rule_matched: r.targeting_rule_matched,
  };
}

function doUpdate(args) {
  const { flag_key, owner_did, default_value, targeting_rules } = args;
  if (!flag_key || !owner_did) return { error: 'flag_key, owner_did required' };
  const flag = getFlag(flag_key);
  if (!flag) return { error: 'flag_not_found' };
  if (flag.owner_did !== owner_did) return { error: 'forbidden_not_owner' };
  const patch = {};
  if (default_value !== undefined) patch.default_value = default_value;
  if (targeting_rules !== undefined) {
    const v = validateRules(targeting_rules, flag.type);
    if (!v.ok) return { error: v.reason };
    patch.targeting_rules = targeting_rules;
  }
  return { ok: true, flag: updateFlag(flag_key, patch) };
}

function doDelete(args) {
  const { flag_key, owner_did } = args;
  if (!flag_key || !owner_did) return { error: 'flag_key, owner_did required' };
  const flag = getFlag(flag_key);
  if (!flag) return { error: 'flag_not_found' };
  if (flag.owner_did !== owner_did) return { error: 'forbidden_not_owner' };
  return { ok: true, tombstone: deleteFlag(flag_key) };
}

function doList(args) {
  const { owner_did } = args;
  if (!owner_did) return { error: 'owner_did required' };
  return { ok: true, owner_did, flags: listFlagsByOwner(owner_did) };
}

function doDescribe(args) {
  const { flag_key } = args;
  if (!flag_key) return { error: 'flag_key required' };
  const flag = getFlag(flag_key);
  if (!flag) return { error: 'flag_not_found' };
  const log = getAuditLog(flag_key, 5);
  return { ok: true, flag, recent_evaluations: log };
}

// ─── REST endpoints (per spec) ────────────────────────────────────────────
app.post('/v1/flag/eval', async (req, res) => {
  const args = req.body || {};
  const tx = txFromReq(req);
  const g = await gateAndCharge({ kind: 'flag_eval', args, did: args.evaluating_did, tx_hash: tx });
  if (!g.ok) {
    if (g.status === 402 && g.body === 'gate') return require402(res, 'flag_eval', args.evaluating_did);
    return res.status(g.status).json(g.body);
  }
  const r = doEval(args);
  res.status(r.error ? 400 : 200).json({ ...r, billed_usd: g.billed_usd });
});

app.get('/v1/flag/list', (req, res) => {
  const r = doList({ owner_did: req.query.owner_did });
  res.status(r.error ? 400 : 200).json(r);
});

// CRUD root endpoints
app.post('/v1/flag', async (req, res) => {
  const args = req.body || {};
  const tx = txFromReq(req);
  const g = await gateAndCharge({ kind: 'flag_create', args, did: args.owner_did, tx_hash: tx });
  if (!g.ok) {
    if (g.status === 402 && g.body === 'gate') return require402(res, 'flag_create', args.owner_did);
    return res.status(g.status).json(g.body);
  }
  const r = doCreate(args);
  res.status(r.error ? 400 : 200).json({ ...r, billed_usd: g.billed_usd });
});

app.patch('/v1/flag/:flag_key', async (req, res) => {
  const args = { ...req.body, flag_key: req.params.flag_key };
  const tx = txFromReq(req);
  const g = await gateAndCharge({ kind: 'flag_update', args, did: args.owner_did, tx_hash: tx });
  if (!g.ok) {
    if (g.status === 402 && g.body === 'gate') return require402(res, 'flag_update', args.owner_did);
    return res.status(g.status).json(g.body);
  }
  const r = doUpdate(args);
  res.status(r.error ? 400 : 200).json({ ...r, billed_usd: g.billed_usd });
});

app.delete('/v1/flag/:flag_key', async (req, res) => {
  const args = { flag_key: req.params.flag_key, owner_did: req.body?.owner_did || req.query.owner_did };
  const tx = txFromReq(req);
  const g = await gateAndCharge({ kind: 'flag_delete', args, did: args.owner_did, tx_hash: tx });
  if (!g.ok) {
    if (g.status === 402 && g.body === 'gate') return require402(res, 'flag_delete', args.owner_did);
    return res.status(g.status).json(g.body);
  }
  const r = doDelete(args);
  res.status(r.error ? 400 : 200).json({ ...r, billed_usd: g.billed_usd });
});

// /v1/flag/{name} GET — describe (must come after the more specific routes above
// would not collide; eval/list/today are exact paths).
app.get('/v1/flag/today', (req, res) => {
  res.json({
    wallet: WALLET_ADDRESS,
    enable: ENABLE,
    prices_usd: PRICES,
    revenue: todayRevenue(),
  });
});

app.get('/v1/flag/:flag_key', (req, res) => {
  const r = doDescribe({ flag_key: req.params.flag_key });
  res.status(r.error ? 404 : 200).json(r);
});

// ─── MCP JSON-RPC ─────────────────────────────────────────────────────────
async function executeTool(name, args, headers) {
  const tx = args.tx_hash || headers['x402-tx-hash'] || null;
  if (!ENABLE) return { error: 'service_disabled' };
  switch (name) {
    case 'flag_eval': {
      const g = await gateAndCharge({ kind: 'flag_eval', args, did: args.evaluating_did, tx_hash: tx });
      if (!g.ok) {
        if (g.status === 402) return { error: 'payment_required', x402: envelope({ kind: 'flag_eval', amount_usd: PRICES.flag_eval, pay_to: WALLET_ADDRESS }) };
        return g.body;
      }
      return { ...doEval(args), billed_usd: g.billed_usd };
    }
    case 'flag_list':     return doList(args);
    case 'flag_describe': return doDescribe(args);
    case 'flag_create': {
      const g = await gateAndCharge({ kind: 'flag_create', args, did: args.owner_did, tx_hash: tx });
      if (!g.ok) {
        if (g.status === 402) return { error: 'payment_required', x402: envelope({ kind: 'flag_create', amount_usd: PRICES.flag_create, pay_to: WALLET_ADDRESS }) };
        return g.body;
      }
      return { ...doCreate(args), billed_usd: g.billed_usd };
    }
    case 'flag_update': {
      const g = await gateAndCharge({ kind: 'flag_update', args, did: args.owner_did, tx_hash: tx });
      if (!g.ok) {
        if (g.status === 402) return { error: 'payment_required', x402: envelope({ kind: 'flag_update', amount_usd: PRICES.flag_update, pay_to: WALLET_ADDRESS }) };
        return g.body;
      }
      return { ...doUpdate(args), billed_usd: g.billed_usd };
    }
    case 'flag_delete': {
      const g = await gateAndCharge({ kind: 'flag_delete', args, did: args.owner_did, tx_hash: tx });
      if (!g.ok) {
        if (g.status === 402) return { error: 'payment_required', x402: envelope({ kind: 'flag_delete', amount_usd: PRICES.flag_delete, pay_to: WALLET_ADDRESS }) };
        return g.body;
      }
      return { ...doDelete(args), billed_usd: g.billed_usd };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC' } });
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id, result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: 'hive-mcp-flag',
              version: '1.0.0',
              description: 'Feature flag service for the A2A network. Hive Civilization.',
            },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const out = await executeTool(name, args || {}, req.headers || {});
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

// ─── Health & discovery ───────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'hive-mcp-flag',
  version: '1.0.0',
  enable: ENABLE,
  brand_color: BRAND_COLOR,
  wallet: WALLET_ADDRESS,
  asset: 'USDC',
  asset_address: USDC_BASE,
  network: 'base',
  prices_usd: PRICES,
  verify_onchain: VERIFY_ONCHAIN,
}));

app.get('/.well-known/mcp.json', (req, res) => res.json({
  name: 'hive-mcp-flag',
  endpoint: '/mcp',
  transport: 'streamable-http',
  protocol: '2024-11-05',
  tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
}));

// ─── Root: HTML for browsers, JSON for agents ─────────────────────────────
const HTML_ROOT = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>hive-mcp-flag — Feature flag service for the A2A network</title>
<meta name="description" content="Feature flag service for the A2A network. DID-keyed targeting, percentage rollouts, x402 USDC settlement on Base. MCP 2024-11-05.">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --gold: ${BRAND_COLOR}; --ink: #111; --paper: #fafaf7; --rule: #e7e3d6; }
  body { background: var(--paper); color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; max-width: 760px; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.55; font-size: 14.5px; }
  h1 { color: var(--gold); font-size: 1.6rem; letter-spacing: 0.01em; margin: 0 0 0.25rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--gold); border-bottom: 1px solid var(--rule); padding-bottom: 0.35rem; margin-top: 2.2rem; }
  .lead { color: #444; margin: 0 0 2rem; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { color: var(--gold); font-weight: 600; }
  code, pre { background: #f3f0e3; padding: 0.1rem 0.35rem; border-radius: 3px; }
  pre { padding: 0.75rem 0.9rem; overflow-x: auto; }
  a { color: var(--gold); text-decoration: none; border-bottom: 1px dotted var(--gold); }
  footer { margin-top: 3rem; color: #777; font-size: 12.5px; }
</style>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "hive-mcp-flag",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Cross-platform",
  "description": "Feature flag service for the A2A network. DID-keyed targeting, percentage rollouts, x402 USDC settlement on Base.",
  "url": "https://hive-mcp-flag.onrender.com",
  "author": { "@type": "Person", "name": "Steve Rotzin", "url": "https://www.thehiveryiq.com" },
  "license": "https://opensource.org/licenses/MIT",
  "offers": [
    { "@type": "Offer", "name": "flag_eval",   "price": "0.0005", "priceCurrency": "USD" },
    { "@type": "Offer", "name": "flag_create", "price": "0.001",  "priceCurrency": "USD" },
    { "@type": "Offer", "name": "flag_update", "price": "0.0005", "priceCurrency": "USD" }
  ]
}
</script>
</head>
<body>
<h1>hive-mcp-flag</h1>
<p class="lead">Feature flag service for the A2A network. Create flags with DID-keyed targeting and percentage rollouts, evaluate them at runtime by agent DID, and roll config changes out without redeploying. Inbound only. Real rails — USDC on Base L2.</p>

<h2>Protocol</h2>
<table>
  <tr><th>MCP version</th><td>2024-11-05 / Streamable-HTTP / JSON-RPC 2.0</td></tr>
  <tr><th>Endpoint</th><td><code>POST /mcp</code></td></tr>
  <tr><th>Discovery</th><td><code>GET /.well-known/mcp.json</code></td></tr>
  <tr><th>Health</th><td><code>GET /health</code></td></tr>
  <tr><th>Settlement</th><td>USDC on Base L2 — verified on-chain</td></tr>
</table>

<h2>Tools and pricing</h2>
<table>
  <tr><th>Tool</th><th>USD / call</th><th>Description</th></tr>
  <tr><td><code>flag_eval</code></td><td>$0.0005</td><td>Evaluate a flag for a DID; returns resolved value and matched rule.</td></tr>
  <tr><td><code>flag_list</code></td><td>free</td><td>List flags owned by a DID.</td></tr>
  <tr><td><code>flag_describe</code></td><td>free</td><td>Full flag definition and recent evaluations.</td></tr>
  <tr><td><code>flag_create</code></td><td>$0.001</td><td>Create a flag with default value and targeting rules.</td></tr>
  <tr><td><code>flag_update</code></td><td>$0.0005</td><td>Update default value or targeting rules. Owner-only.</td></tr>
  <tr><td><code>flag_delete</code></td><td>$0.001</td><td>Tombstone a flag. Owner-only.</td></tr>
</table>

<h2>Targeting rule shape</h2>
<pre>[
  { "type": "did_match",  "dids": ["did:hive:0xabc"], "value": true },
  { "type": "did_prefix", "prefix": "did:hive:",      "value": true },
  { "type": "rollout",    "percent": 25,              "value": true }
]</pre>
<p>Rules evaluate in declared order; first match wins. Rollout uses <code>SHA256(did + flag_key) mod 100</code>, so each DID lands in a sticky bucket.</p>

<h2>REST endpoints</h2>
<table>
  <tr><th>Method</th><th>Path</th><th>Purpose</th></tr>
  <tr><td>POST</td><td><code>/v1/flag/eval</code></td><td>Evaluate a flag for a DID.</td></tr>
  <tr><td>GET</td><td><code>/v1/flag/list</code></td><td>List flags by owner DID.</td></tr>
  <tr><td>GET</td><td><code>/v1/flag/{name}</code></td><td>Describe one flag.</td></tr>
  <tr><td>POST</td><td><code>/v1/flag</code></td><td>Create a flag.</td></tr>
  <tr><td>PATCH</td><td><code>/v1/flag/{name}</code></td><td>Update a flag. Owner-only.</td></tr>
  <tr><td>DELETE</td><td><code>/v1/flag/{name}</code></td><td>Tombstone a flag. Owner-only.</td></tr>
  <tr><td>GET</td><td><code>/v1/flag/today</code></td><td>Today's revenue snapshot.</td></tr>
  <tr><td>GET</td><td><code>/health</code></td><td>Service health.</td></tr>
</table>

<footer>
  <p>Hive Civilization · Pantone 1245 C / ${BRAND_COLOR} · MIT · <a href="https://github.com/srotzin/hive-mcp-flag">github.com/srotzin/hive-mcp-flag</a></p>
</footer>
</body></html>`;

app.get('/', (req, res) => {
  const accept = String(req.headers.accept || '').toLowerCase();
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return res.json({
      name: 'hive-mcp-flag',
      version: '1.0.0',
      description: 'Feature flag service for the A2A network. Hive Civilization.',
      endpoint: '/mcp',
      transport: 'streamable-http',
      protocol: '2024-11-05',
      tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
      enable: ENABLE,
      brand_color: BRAND_COLOR,
      prices_usd: PRICES,
      wallet: WALLET_ADDRESS,
    });
  }
  res.set('content-type', 'text/html; charset=utf-8').send(HTML_ROOT);
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`hive-mcp-flag on :${PORT}`);
    console.log(`  enable        : ${ENABLE}`);
    console.log(`  wallet        : ${WALLET_ADDRESS}`);
    console.log(`  usdc(base)    : ${USDC_BASE}`);
    console.log(`  verify_onchain: ${VERIFY_ONCHAIN}`);
    console.log(`  prices        : ${JSON.stringify(PRICES)}`);
  });
}

export default app;


// ─── Schema discoverability ────────────────────────────────────────────────
const AGENT_CARD = {
  name: SERVICE,
  description: 'Feature flag service for the A2A network. DID-keyed targeting, percentage rollouts, x402 USDC settlement on Base. MCP 2024-11-05. Inbound only. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.',
  url: `https://${SERVICE}.onrender.com`,
  provider: {
    organization: 'Hive Civilization',
    url: 'https://www.thehiveryiq.com',
    contact: 'steve@thehiveryiq.com',
  },
  version: VERSION,
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  authentication: {
    schemes: ['x402'],
    credentials: {
      type: 'x402',
      asset: 'USDC',
      network: 'base',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    { name: 'flag_list', description: 'List flags owned by a DID. Read-only, no charge.' },
    { name: 'flag_describe', description: 'Return the full definition of a flag — type, default value, targeting rules, evaluation count. Read-only, no charge.' },
  ],
  extensions: {
    hive_pricing: {
      currency: 'USDC',
      network: 'base',
      model: 'per_call',
      first_call_free: true,
      loyalty_threshold: 6,
      loyalty_message: 'Every 6th paid call is free',
    },
  },
};

const AP2 = {
  ap2_version: '1',
  agent: {
    name: SERVICE,
    did: `did:web:${SERVICE}.onrender.com`,
    description: 'Feature flag service for the A2A network. DID-keyed targeting, percentage rollouts, x402 USDC settlement on Base. MCP 2024-11-05. Inbound only. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.',
  },
  endpoints: {
    mcp: `https://${SERVICE}.onrender.com/mcp`,
    agent_card: `https://${SERVICE}.onrender.com/.well-known/agent-card.json`,
  },
  payments: {
    schemes: ['x402'],
    primary: {
      scheme: 'x402',
      network: 'base',
      asset: 'USDC',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    },
  },
  brand: { color: '#C08D23', name: 'Hive Civilization' },
};

app.get('/.well-known/agent-card.json', (req, res) => res.json(AGENT_CARD));
app.get('/.well-known/ap2.json',         (req, res) => res.json(AP2));

