import { describe, expect, it } from 'vitest';
import { argsHash, canonicalJson, deterministicId } from '../ids.js';

/** The frozen contracts validate ids with z.string().uuid(); keep that promise. */
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deterministicId', () => {
  it('returns the same uuid for the same namespace and key', () => {
    const a = deterministicId('aqar.ticket', 'wamid.HBgM1234');
    const b = deterministicId('aqar.ticket', 'wamid.HBgM1234');
    expect(a).toBe(b);
  });

  it('produces a uuid-v5-shaped string the contracts accept', () => {
    expect(deterministicId('aqar.promise', 'abc')).toMatch(UUID_V5);
  });

  it('separates namespaces so one key cannot collide across entity types', () => {
    expect(deterministicId('aqar.ticket', 'k')).not.toBe(deterministicId('aqar.promise', 'k'));
  });

  it('is sensitive to the whole key, including its tail', () => {
    expect(deterministicId('ns', 'key-a')).not.toBe(deterministicId('ns', 'key-b'));
  });
});

describe('canonicalJson', () => {
  it('sorts object keys so insertion order cannot change the hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order because argument order can be meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('recurses into nested objects', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: null })).toBe('{"a":null,"z":{"x":2,"y":1}}');
  });

  it('keeps primitives untouched and renders undefined as null', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('argsHash', () => {
  it('is identical regardless of key order', () => {
    expect(argsHash({ leaseId: 'l', amountFils: 250000 })).toBe(
      argsHash({ amountFils: 250000, leaseId: 'l' }),
    );
  });

  it('changes when any value changes — the dedupe guard depends on it', () => {
    expect(argsHash({ amountFils: 250000 })).not.toBe(argsHash({ amountFils: 250001 }));
  });

  it('distinguishes a nested reshape that a naive JSON.stringify would miss', () => {
    expect(argsHash({ a: { b: 1, c: 2 } })).toBe(argsHash({ a: { c: 2, b: 1 } }));
  });
});
