/**
 * Helpers for writing JSON Schemas that satisfy Claude structured outputs
 * (https://platform.claude.com/docs/en/build-with-claude/structured-outputs): root is a plain object, every object has
 * additionalProperties:false and lists every property in `required`, no allOf/oneOf, no recursion, at most 16 unions.
 * The helpers make conformance the default; assertStrict() re-checks a finished schema so a hand-written
 * schema that would be rejected with HTTP 400 fails here instead.
 *
 * Value constraints the API rejects (minimum, maximum, minLength, maxLength, multipleOf, maxItems, minItems above 1)
 * may still be written here: toClaudeSchema() strips them from the copy sent to the API and moves them into the
 * description, while validate() keeps enforcing the original locally and the executor retries on a violation.
 */
import Ajv from 'ajv';

export const str = (description, extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
export const int = (description, extra = {}) => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
export const num = (description, extra = {}) => ({ type: 'number', ...(description ? { description } : {}), ...extra });
export const bool = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });
export const enm = (values, description) => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
export const arr = (items, description, extra = {}) => ({ type: 'array', items, ...(description ? { description } : {}), ...extra });

/** Object with every property required and no extras (strict mode). */
export function obj(properties, description) {
  return {
    type: 'object',
    ...(description ? { description } : {}),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** Throw if `schema` violates the strict-mode subset. Returns the schema for chaining. */
export function assertStrict(schema, path = '$') {
  if (path === '$' && (schema.type !== 'object')) throw new Error(`${path}: strict-mode root must be an object`);
  walk(schema, path, 0);
  return schema;
}

const MAX_UNIONS = 16; // per request, anyOf or a type array

function walk(node, path, depth, state = { unions: 0 }) {
  if (depth > 10) throw new Error(`${path}: nesting deeper than 10 levels`);
  if (node == null || typeof node !== 'object') return;
  for (const k of ['allOf', 'oneOf', '$ref', 'not']) if (k in node) throw new Error(`${path}: '${k}' is not allowed in strict mode`);
  if (Array.isArray(node.enum) && node.enum.some((v) => v !== null && typeof v === 'object')) throw new Error(`${path}: enum values must be strings, numbers, booleans or null`);
  if ('anyOf' in node || Array.isArray(node.type)) {
    if (path === '$') throw new Error(`${path}: a union is not allowed at the root`);
    if (++state.unions > MAX_UNIONS) throw new Error(`${path}: more than ${MAX_UNIONS} unions (anyOf or type arrays) in one schema`);
  }
  if ('anyOf' in node) node.anyOf.forEach((s, i) => walk(s, `${path}.anyOf[${i}]`, depth + 1, state));
  if (node.type === 'object') {
    if (node.additionalProperties !== false) throw new Error(`${path}: object must set additionalProperties:false`);
    const props = Object.keys(node.properties ?? {});
    const req = node.required ?? [];
    const missing = props.filter((p) => !req.includes(p));
    if (missing.length) throw new Error(`${path}: required must list every property (missing: ${missing.join(', ')})`);
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`, depth + 1, state);
  }
  if (node.type === 'array') walk(node.items, `${path}[]`, depth + 1, state);
}

// ─── Claude request form ────────────────────────────────────

const DROPPED = {
  minimum: (v) => `minimum ${v}`, maximum: (v) => `maximum ${v}`,
  exclusiveMinimum: (v) => `greater than ${v}`, exclusiveMaximum: (v) => `less than ${v}`, multipleOf: (v) => `a multiple of ${v}`,
  minLength: (v) => `at least ${v} characters`, maxLength: (v) => `at most ${v} characters`, maxItems: (v) => `at most ${v} items`,
};

/**
 * A copy of `schema` that the Claude API accepts: unsupported value constraints are removed and stated in the
 * field's description instead (minItems 0 and 1 are supported and kept). The input is not modified.
 */
export function toClaudeSchema(schema) {
  const walkCopy = (node) => {
    if (Array.isArray(node)) return node.map(walkCopy);
    if (node == null || typeof node !== 'object') return node;
    const out = {};
    const notes = [];
    for (const [k, v] of Object.entries(node)) {
      if (k in DROPPED) { notes.push(DROPPED[k](v)); continue; }
      if (k === 'minItems' && v > 1) { notes.push(`at least ${v} items`); continue; }
      // property maps hold schemas keyed by field name; everything else recurses structurally
      out[k] = k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walkCopy(pv)])) : walkCopy(v);
    }
    if (notes.length) out.description = `${out.description ? `${out.description} ` : ''}(${notes.join('; ')})`;
    return out;
  };
  return walkCopy(schema);
}

/**
 * Claude can change the capitalization of an enum value (typically the first letter after a space). Snap every string
 * the schema constrains by `enum` back to the one canonical value that matches case-insensitively; anything else is
 * left for validate() to reject. Does not look inside anyOf.
 */
export function canonicalizeEnums(value, schema) {
  if (value == null || schema == null || typeof schema !== 'object') return value;
  if (typeof value === 'string') {
    if (!Array.isArray(schema.enum) || schema.enum.includes(value)) return value;
    const hits = schema.enum.filter((e) => typeof e === 'string' && e.toLowerCase() === value.toLowerCase());
    return hits.length === 1 ? hits[0] : value;
  }
  if (Array.isArray(value)) return value.map((v) => canonicalizeEnums(v, schema.items));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonicalizeEnums(v, schema.properties?.[k])]));
  return value;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap();

/** Validate an instance against a schema; returns { ok, errors: string[] }. */
export function validate(schema, instance) {
  let fn = compiled.get(schema);
  if (!fn) { fn = ajv.compile(schema); compiled.set(schema, fn); }
  const ok = fn(instance);
  return { ok, errors: ok ? [] : (fn.errors ?? []).map((e) => `${e.instancePath || '$'} ${e.message}`) };
}
