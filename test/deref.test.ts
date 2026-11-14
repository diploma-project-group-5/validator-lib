// The build-time $ref inliner behind inputSchemaFlat (scripts/deref.mjs). Ajv validates a $ref by calling
// a separate function and concatenating its errors onto all errors so far, which is quadratic on junk
// input with allErrors; the inlined copy has no calls. Anything it cannot inline exactly fails the build.
import { describe, expect, it } from 'vitest';

import { deref } from '../scripts/deref.mjs';

const BASE = 'https://lad.example/s/';
const defs = {
  $id: `${BASE}events/defs.json`,
  $defs: {
    id: { $comment: 'opaque', type: 'string', minLength: 1 },
    pair: { type: 'array', items: { $ref: '#/$defs/id' } },
    'a/b~c': { const: 1 },
  },
};
const at = (schema: object): object => ({ $id: `${BASE}r.json`, ...schema });

describe('deref', () => {
  it('inlines each $ref as allOf, resolving relative refs against the $id of the document they are in', () => {
    const root = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${BASE}validator/input.json`,
      type: 'object',
      properties: { ids: { $ref: '../events/defs.json#/$defs/pair', description: 'kept' } },
    };
    expect(deref(root, [defs])).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${BASE}validator/input.json`,
      type: 'object',
      properties: {
        ids: { allOf: [{ type: 'array', items: { allOf: [{ type: 'string', minLength: 1 }] } }], description: 'kept' },
      },
    });
  });

  it('resolves local refs, escaped pointers and a whole document', () => {
    const root = {
      $id: `${BASE}r.json`,
      $defs: { n: { type: 'integer' } },
      prefixItems: [{ $ref: '#/$defs/n' }, { $ref: 'events/defs.json#/$defs/a~1b~0c' }, { $ref: 'events/defs.json' }],
    };
    expect(deref(root, [defs])).toEqual({
      $id: `${BASE}r.json`,
      prefixItems: [{ allOf: [{ type: 'integer' }] }, { allOf: [{ const: 1 }] }, { allOf: [{}] }],
    });
  });

  it('walks every applicator but never data: properties named like keywords and const/enum values stay', () => {
    const root = {
      $id: `${BASE}r.json`,
      $defs: { t: { type: 'null' } },
      properties: { $ref: { type: 'string' }, $id: { const: { $ref: '#/$defs/t' } } },
      patternProperties: { '^x': { $ref: '#/$defs/t' } },
      dependentSchemas: { a: { $ref: '#/$defs/t' } },
      additionalProperties: { $ref: '#/$defs/t' },
      propertyNames: { $ref: '#/$defs/t' },
      unevaluatedProperties: { $ref: '#/$defs/t' },
      items: { $ref: '#/$defs/t' },
      contains: { $ref: '#/$defs/t' },
      unevaluatedItems: { $ref: '#/$defs/t' },
      allOf: [{ $ref: '#/$defs/t' }],
      anyOf: [{ $ref: '#/$defs/t' }, true],
      oneOf: [{ $ref: '#/$defs/t' }, false],
      not: { $ref: '#/$defs/t' },
      if: { $ref: '#/$defs/t' },
      then: { $ref: '#/$defs/t' },
      else: { $ref: '#/$defs/t' },
      enum: [{ $ref: 'kept' }],
    };
    const t = { allOf: [{ type: 'null' }] };
    expect(deref(root, [])).toEqual({
      $id: `${BASE}r.json`,
      properties: { $ref: { type: 'string' }, $id: { const: { $ref: '#/$defs/t' } } },
      patternProperties: { '^x': t },
      dependentSchemas: { a: t },
      additionalProperties: t,
      propertyNames: t,
      unevaluatedProperties: t,
      items: t,
      contains: t,
      unevaluatedItems: t,
      allOf: [t],
      anyOf: [t, true],
      oneOf: [t, false],
      not: t,
      if: t,
      then: t,
      else: t,
      enum: [{ $ref: 'kept' }],
    });
  });

  it('strips nested $id, $defs, $anchor, $schema and $comment, keeping the root identity', () => {
    const root = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${BASE}r.json`,
      $comment: 'root comment',
      items: { $schema: 'x', $id: 'inner.json', $anchor: 'a', $comment: 'c', $defs: { z: {} }, type: 'integer' },
    };
    expect(deref(root, [])).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${BASE}r.json`,
      items: { type: 'integer' },
    });
  });

  it('fails the build on a cycle, a dynamic ref, an anchor or an unresolvable ref', () => {
    const loop = at({ $defs: { a: { items: { $ref: '#/$defs/b' } }, b: { not: { $ref: '#/$defs/a' } } }, items: { $ref: '#/$defs/a' } });
    expect(() => deref(loop, [])).toThrow(new Error(`$ref cycle at ${BASE}r.json#/$defs/a`));
    expect(() => deref(at({ $ref: '#' }), [])).toThrow(new Error(`$ref cycle at ${BASE}r.json#`));
    expect(() => deref(at({ items: { $dynamicRef: '#meta' } }), [])).toThrow(new Error('$dynamicRef is not supported'));
    expect(() => deref(at({ items: { $recursiveRef: '#' } }), [])).toThrow(new Error('$recursiveRef is not supported'));
    expect(() => deref(at({ items: { $ref: '#meta' } }), [])).toThrow(new Error(`unsupported $ref ${BASE}r.json#meta`));
    expect(() => deref(at({ items: { $ref: 'other.json' } }), [])).toThrow(new Error(`unresolvable $ref ${BASE}other.json`));
    expect(() => deref(at({ items: { $ref: '#/$defs/none' } }), [])).toThrow(new Error(`unresolvable $ref ${BASE}r.json#/$defs/none`));
    expect(() => deref(at({ $defs: { s: 'x' }, items: { $ref: '#/$defs/s/length' } }), [])).toThrow(
      new Error(`unresolvable $ref ${BASE}r.json#/$defs/s/length`),
    );
    expect(() => deref(at({ $defs: { n: 1 }, items: { $ref: '#/$defs/n' } }), [])).toThrow(
      new Error(`$ref to a non-schema ${BASE}r.json#/$defs/n`),
    );
    // Below a nested $id, '#' is that subschema, not the root: the ref must not resolve to the root's y.
    const inner = { $id: 'x.json', $defs: { y: { type: 'null' } }, items: { $ref: '#/$defs/y' } };
    expect(() => deref(at({ $defs: { x: inner, y: {} }, items: { $ref: '#/$defs/x/items' } }), [])).toThrow(
      new Error(`unresolvable $ref ${BASE}x.json#/$defs/y`),
    );
    expect(() => deref(at({ $defs: { y: {} }, items: { $id: 'x.json', items: { $ref: '#/$defs/y' } } }), [])).toThrow(
      new Error(`unresolvable $ref ${BASE}x.json#/$defs/y`),
    );
    expect(() => deref({ items: {} }, [])).toThrow(new Error('the root schema needs an absolute $id'));
  });

  it('a target reached twice on different branches is inlined twice, not taken for a cycle', () => {
    const root = at({ $defs: { n: { type: 'integer' } }, prefixItems: [{ $ref: '#/$defs/n' }, { $ref: '#/$defs/n' }] });
    expect(deref(root, [])).toMatchObject({ prefixItems: [{ allOf: [{ type: 'integer' }] }, { allOf: [{ type: 'integer' }] }] });
  });
});
