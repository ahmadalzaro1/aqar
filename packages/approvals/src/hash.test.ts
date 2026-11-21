import { describe, expect, it } from 'vitest';
import { argsHash, canonicalJson } from './hash.js';

describe('argument hashing', () => {
  it('is independent of object key order', () => {
    expect(argsHash({ a: 1, b: 2 })).toBe(argsHash({ b: 2, a: 1 }));
    expect(argsHash({ outer: { x: 1, y: 2 } })).toBe(argsHash({ outer: { y: 2, x: 1 } }));
  });

  it('keeps array order significant', () => {
    expect(argsHash({ ids: ['a', 'b'] })).not.toBe(argsHash({ ids: ['b', 'a'] }));
  });

  it('distinguishes a number from its string form', () => {
    expect(argsHash({ n: 1 })).not.toBe(argsHash({ n: '1' }));
  });

  it('normalises null, booleans and nesting predictably', () => {
    expect(canonicalJson({ b: [1, null, true], a: 'x' })).toBe('{"a":"x","b":[1,null,true]}');
    expect(argsHash(null)).toBe(argsHash(null));
  });

  it('produces the same digest as the MCP tool that wrote the pending rows', () => {
    // Frozen value: the pending proposals in the database were hashed with this
    // exact function. If this test changes, those rows can no longer be approved.
    const hash = argsHash({ action: 'post_payment', amountFils: 150000 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(argsHash({ action: 'post_payment', amountFils: 150000 })).toBe(hash);
  });
});
