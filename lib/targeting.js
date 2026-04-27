/**
 * Deterministic targeting evaluator for hive-mcp-flag.
 *
 * Rules are evaluated in declared order. First match wins. If no rule
 * matches, the flag's default value is returned.
 *
 * Supported rule types:
 *   { type: 'did_match',   dids: [...],          value: <flag_value> }
 *   { type: 'did_prefix',  prefix: 'did:hive:',  value: <flag_value> }
 *   { type: 'rollout',     percent: 0..100,      value: <flag_value> }
 *
 * Percentage rollout uses SHA256(did + flag_key) mod 100 so the same
 * (did, flag_key) tuple always lands in the same bucket.
 */

import crypto from 'node:crypto';

export function bucketFor(did, flag_key) {
  const h = crypto.createHash('sha256').update(`${did}:${flag_key}`).digest();
  return h.readUInt32BE(0) % 100;
}

export function evaluate({ flag, did }) {
  if (!flag) return { matched: false };
  const rules = Array.isArray(flag.targeting_rules) ? flag.targeting_rules : [];
  for (const rule of rules) {
    switch (rule.type) {
      case 'did_match':
        if (Array.isArray(rule.dids) && rule.dids.includes(did)) {
          return { resolved_value: rule.value, targeting_rule_matched: 'did_match' };
        }
        break;
      case 'did_prefix':
        if (typeof rule.prefix === 'string' && did.startsWith(rule.prefix)) {
          return { resolved_value: rule.value, targeting_rule_matched: `did_prefix:${rule.prefix}` };
        }
        break;
      case 'rollout':
        if (Number.isFinite(rule.percent)) {
          const b = bucketFor(did, flag.flag_key);
          if (b < Math.max(0, Math.min(100, rule.percent))) {
            return { resolved_value: rule.value, targeting_rule_matched: `rollout:${rule.percent}` };
          }
        }
        break;
      default:
        break;
    }
  }
  return { resolved_value: flag.default_value, targeting_rule_matched: 'default' };
}

export function validateRules(rules, type) {
  if (!Array.isArray(rules)) return { ok: false, reason: 'targeting_rules must be an array' };
  if (rules.length > 50) return { ok: false, reason: 'too many targeting rules (max 50)' };
  for (const r of rules) {
    if (!r || typeof r !== 'object') return { ok: false, reason: 'rule must be an object' };
    if (!['did_match', 'did_prefix', 'rollout'].includes(r.type)) {
      return { ok: false, reason: `unknown rule type: ${r.type}` };
    }
    if (!coerce(r.value, type)) {
      return { ok: false, reason: `rule value does not match flag type ${type}` };
    }
    if (r.type === 'rollout' && !(Number.isFinite(r.percent) && r.percent >= 0 && r.percent <= 100)) {
      return { ok: false, reason: 'rollout.percent must be in [0, 100]' };
    }
    if (r.type === 'did_match' && !(Array.isArray(r.dids) && r.dids.length > 0)) {
      return { ok: false, reason: 'did_match.dids must be a non-empty array' };
    }
    if (r.type === 'did_prefix' && (typeof r.prefix !== 'string' || r.prefix.length === 0)) {
      return { ok: false, reason: 'did_prefix.prefix must be a non-empty string' };
    }
  }
  return { ok: true };
}

function coerce(v, type) {
  switch (type) {
    case 'boolean': return typeof v === 'boolean';
    case 'string':  return typeof v === 'string';
    case 'number':  return typeof v === 'number' && Number.isFinite(v);
    case 'json':    return v !== undefined;
    default: return false;
  }
}
