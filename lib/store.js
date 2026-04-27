/**
 * SQLite-backed flag store for hive-mcp-flag.
 *
 * Persists flag definitions, targeting rules, evaluation audit log,
 * and subscription state. Single-node only — Render starter is fine.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.DB_PATH || '/tmp/flag.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

export function openDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS flags (
      flag_key       TEXT PRIMARY KEY,
      owner_did      TEXT NOT NULL,
      type           TEXT NOT NULL,
      default_value  TEXT NOT NULL,
      targeting_rules TEXT NOT NULL DEFAULT '[]',
      created_ms     INTEGER NOT NULL,
      updated_ms     INTEGER NOT NULL,
      tombstoned_ms  INTEGER
    );
    CREATE INDEX IF NOT EXISTS flags_owner_idx ON flags(owner_did);

    CREATE TABLE IF NOT EXISTS audit (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      flag_key              TEXT NOT NULL,
      evaluating_did        TEXT NOT NULL,
      resolved_value        TEXT NOT NULL,
      targeting_rule_matched TEXT NOT NULL,
      ts_ms                 INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_flag_idx ON audit(flag_key, ts_ms);

    CREATE TABLE IF NOT EXISTS subscriptions (
      did            TEXT PRIMARY KEY,
      activated_ms   INTEGER NOT NULL,
      expires_ms     INTEGER NOT NULL,
      tx_hash        TEXT
    );

    CREATE TABLE IF NOT EXISTS eval_counts (
      flag_key TEXT PRIMARY KEY,
      n        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS revenue (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      kind      TEXT NOT NULL,
      did       TEXT,
      flag_key  TEXT,
      amount_usd REAL NOT NULL,
      tx_hash   TEXT UNIQUE,
      payer     TEXT,
      ts_ms     INTEGER NOT NULL
    );
  `);
  return db;
}

export function createFlag({ flag_key, owner_did, type, default_value, targeting_rules }) {
  const now = Date.now();
  openDb().prepare(`
    INSERT INTO flags(flag_key, owner_did, type, default_value, targeting_rules, created_ms, updated_ms)
    VALUES (@flag_key, @owner_did, @type, @default_value, @targeting_rules, @now, @now)
  `).run({
    flag_key, owner_did, type,
    default_value: JSON.stringify(default_value),
    targeting_rules: JSON.stringify(targeting_rules || []),
    now,
  });
  return getFlag(flag_key);
}

export function getFlag(flag_key) {
  const row = openDb().prepare(`SELECT * FROM flags WHERE flag_key = ? AND tombstoned_ms IS NULL`).get(flag_key);
  if (!row) return null;
  return {
    flag_key: row.flag_key,
    owner_did: row.owner_did,
    type: row.type,
    default_value: JSON.parse(row.default_value),
    targeting_rules: JSON.parse(row.targeting_rules),
    created_ms: row.created_ms,
    updated_ms: row.updated_ms,
  };
}

export function updateFlag(flag_key, patch) {
  const flag = getFlag(flag_key);
  if (!flag) return null;
  const next = {
    default_value: 'default_value' in patch ? patch.default_value : flag.default_value,
    targeting_rules: 'targeting_rules' in patch ? patch.targeting_rules : flag.targeting_rules,
    updated_ms: Date.now(),
  };
  openDb().prepare(`
    UPDATE flags SET default_value = ?, targeting_rules = ?, updated_ms = ?
    WHERE flag_key = ?
  `).run(
    JSON.stringify(next.default_value),
    JSON.stringify(next.targeting_rules),
    next.updated_ms,
    flag_key,
  );
  return getFlag(flag_key);
}

export function deleteFlag(flag_key) {
  const now = Date.now();
  const r = openDb().prepare(`UPDATE flags SET tombstoned_ms = ? WHERE flag_key = ? AND tombstoned_ms IS NULL`).run(now, flag_key);
  return r.changes > 0 ? { flag_key, tombstoned_ms: now } : null;
}

export function listFlagsByOwner(owner_did) {
  const rows = openDb().prepare(`
    SELECT f.*, COALESCE(c.n, 0) AS eval_count
    FROM flags f LEFT JOIN eval_counts c ON c.flag_key = f.flag_key
    WHERE f.owner_did = ? AND f.tombstoned_ms IS NULL
    ORDER BY f.updated_ms DESC
  `).all(owner_did);
  return rows.map(r => ({
    flag_key: r.flag_key,
    owner_did: r.owner_did,
    type: r.type,
    default_value: JSON.parse(r.default_value),
    targeting_rules: JSON.parse(r.targeting_rules),
    created_ms: r.created_ms,
    updated_ms: r.updated_ms,
    eval_count: r.eval_count,
  }));
}

export function recordEvaluation({ flag_key, evaluating_did, resolved_value, targeting_rule_matched }) {
  const ts = Date.now();
  const dbh = openDb();
  dbh.prepare(`
    INSERT INTO audit(flag_key, evaluating_did, resolved_value, targeting_rule_matched, ts_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(flag_key, evaluating_did, JSON.stringify(resolved_value), targeting_rule_matched, ts);
  dbh.prepare(`
    INSERT INTO eval_counts(flag_key, n) VALUES (?, 1)
    ON CONFLICT(flag_key) DO UPDATE SET n = n + 1
  `).run(flag_key);
  return ts;
}

export function getAuditLog(flag_key, limit = 100) {
  const rows = openDb().prepare(`
    SELECT * FROM audit WHERE flag_key = ? ORDER BY ts_ms DESC LIMIT ?
  `).all(flag_key, limit);
  return rows.map(r => ({
    flag_key: r.flag_key,
    evaluating_did: r.evaluating_did,
    resolved_value: JSON.parse(r.resolved_value),
    targeting_rule_matched: r.targeting_rule_matched,
    ts_ms: r.ts_ms,
  }));
}

export function activateSubscription({ did, tx_hash }) {
  const now = Date.now();
  const expires = now + 30 * 24 * 60 * 60 * 1000;
  openDb().prepare(`
    INSERT INTO subscriptions(did, activated_ms, expires_ms, tx_hash)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET activated_ms = excluded.activated_ms, expires_ms = excluded.expires_ms, tx_hash = excluded.tx_hash
  `).run(did, now, expires, tx_hash || null);
  return { did, activated_ms: now, expires_ms: expires };
}

export function isSubscribed(did) {
  const row = openDb().prepare(`SELECT expires_ms FROM subscriptions WHERE did = ?`).get(did);
  if (!row) return false;
  return row.expires_ms > Date.now();
}

export function recordRevenue({ kind, did, flag_key, amount_usd, tx_hash, payer }) {
  try {
    openDb().prepare(`
      INSERT INTO revenue(kind, did, flag_key, amount_usd, tx_hash, payer, ts_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(kind, did || null, flag_key || null, amount_usd, tx_hash || null, payer || null, Date.now());
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) throw err;
  }
}

export function todayRevenue() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = openDb().prepare(`
    SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount_usd), 0) AS sum_usd
    FROM revenue WHERE ts_ms >= ? GROUP BY kind
  `).all(since);
  const byKind = Object.fromEntries(rows.map(r => [r.kind, { calls: r.n, usd: r.sum_usd }]));
  const total = rows.reduce((a, r) => a + r.sum_usd, 0);
  return { since_ms: since, by_kind: byKind, total_usd: Number(total.toFixed(6)) };
}
