// Inlines every $ref of a JSON Schema (2020-12) at build time, for scripts/sync-schemas.mjs.
//
// Why: Ajv validates a $ref by calling a separately compiled function and appending its errors with
// `vErrors.concat(...)`, a copy of all errors collected so far. With allErrors on junk input that is
// quadratic (bug 6). A schema without $ref compiles into one function that pushes errors in place.
//
// Each $ref becomes `{ allOf: [target], ...siblings }`. The allOf wrapper keeps the evaluation, and so the
// errors, exactly as with the $ref (for example, Ajv takes a fast path for uniqueItems when it sees the
// item type directly). $defs and $comment, and below the root $id, $anchor and $schema, are dropped:
// nothing refers to them any more. Whatever cannot be inlined exactly (a cycle, $dynamicRef, an anchor, a ref that does not
// resolve) throws, so a new form of $ref in contracts fails the build instead of changing validation.

/** Keywords whose value is a schema. */
const SCHEMA = new Set([
  'items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else',
  'unevaluatedItems', 'unevaluatedProperties',
]);
/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAP = new Set(['properties', 'patternProperties', 'dependentSchemas']);
/** Definitions and comments: nothing needs them once every $ref is inlined. */
const DROP = new Set(['$defs', 'definitions', '$comment']);
/** Identity of a document: kept at the root only. */
const NESTED_DROP = new Set(['$id', '$anchor', '$schema']);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSchema = (v) => typeof v === 'boolean' || isObject(v);

/**
 * @param {object} root the schema to inline; needs an absolute `$id`
 * @param {readonly object[]} others further documents that refs may point to, found by their `$id`
 * @returns {object} an equivalent schema without `$ref`
 */
export function deref(root, others) {
  if (typeof root.$id !== 'string' || !URL.canParse(root.$id)) throw new Error('the root schema needs an absolute $id');
  const docs = new Map([root, ...others].map((d) => [new URL(d.$id).href, d]));

  const resolve = (ref, base) => {
    const url = new URL(ref, base);
    const href = url.href;
    url.hash = '';
    const doc = docs.get(url.href);
    const fragment = decodeURIComponent(href.slice(url.href.length + 1));
    if (fragment !== '' && !fragment.startsWith('/')) throw new Error(`unsupported $ref ${href}`);
    if (doc === undefined) throw new Error(`unresolvable $ref ${href}`);
    let target = doc;
    let targetBase = url.href;
    for (const token of fragment.split('/').slice(1)) {
      const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
      if (typeof target !== 'object' || target === null || !Object.hasOwn(target, key)) {
        throw new Error(`unresolvable $ref ${href}`);
      }
      // Pointing below a subschema with its own $id: refs in the target resolve against that $id.
      if (target !== doc && typeof target.$id === 'string') targetBase = new URL(target.$id, targetBase).href;
      target = target[key];
    }
    if (!isSchema(target)) throw new Error(`$ref to a non-schema ${href}`);
    return { key: `${url.href}#${fragment}`, target, base: targetBase };
  };

  /** `stack`: the refs being inlined on the way here, to tell a cycle from a target reached twice. */
  const walk = (node, base, stack, nested) => {
    if (typeof node === 'boolean') return node;
    for (const k of ['$dynamicRef', '$recursiveRef']) {
      if (k in node) throw new Error(`${k} is not supported`);
    }
    // A nested $id moves the base; refs below it then resolve to an unknown document and throw.
    const here = nested && typeof node.$id === 'string' ? new URL(node.$id, base).href : base;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' || DROP.has(k) || (nested && NESTED_DROP.has(k))) continue;
      if (SCHEMA.has(k)) out[k] = walk(v, here, stack, true);
      else if (SCHEMA_LIST.has(k)) out[k] = v.map((s) => walk(s, here, stack, true));
      else if (SCHEMA_MAP.has(k)) out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, walk(s, here, stack, true)]));
      else out[k] = v;
    }
    if (!('$ref' in node)) return out;
    const { key, target, base: targetBase } = resolve(node.$ref, here);
    if (stack.includes(key)) throw new Error(`$ref cycle at ${key}`);
    return { allOf: [walk(target, targetBase, [...stack, key], true)], ...out };
  };

  return walk(root, new URL(root.$id).href, [], false);
}
