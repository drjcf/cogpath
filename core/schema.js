/**
 * Helpers for writing JSON Schemas that satisfy Meta Model API strict mode
 * (https://dev.meta.ai/docs/structured-output): root is a plain object, every object has
 * additionalProperties:false and lists every property in `required`, no allOf/oneOf, no recursion.
 * The helpers make conformance the default; assertStrict() re-checks a finished schema so a hand-written
 * schema that would be rejected with HTTP 400 fails here instead.
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

function walk(node, path, depth) {
  if (depth > 10) throw new Error(`${path}: nesting deeper than 10 levels`);
  if (node == null || typeof node !== 'object') return;
  for (const k of ['allOf', 'oneOf', '$ref', 'not']) if (k in node) throw new Error(`${path}: '${k}' is not allowed in strict mode`);
  if ('anyOf' in node) {
    if (path === '$') throw new Error(`${path}: anyOf is not allowed at the root`);
    node.anyOf.forEach((s, i) => walk(s, `${path}.anyOf[${i}]`, depth + 1));
  }
  if (node.type === 'object') {
    if (node.additionalProperties !== false) throw new Error(`${path}: object must set additionalProperties:false`);
    const props = Object.keys(node.properties ?? {});
    const req = node.required ?? [];
    const missing = props.filter((p) => !req.includes(p));
    if (missing.length) throw new Error(`${path}: required must list every property (missing: ${missing.join(', ')})`);
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`, depth + 1);
  }
  if (node.type === 'array') walk(node.items, `${path}[]`, depth + 1);
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
