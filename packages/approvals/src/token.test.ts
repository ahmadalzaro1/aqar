import { describe, expect, it } from 'vitest';
import { mintApprovalToken, verifyApprovalToken, type ApprovalClaims } from './token.js';

const SECRET = 'a'.repeat(48);
const NOW = new Date('2026-11-21T12:00:00Z');
const base: ApprovalClaims = {
  proposalId: '11111111-2222-3333-4444-555555555555',
  toolName: 'propose_payment',
  argsHash: 'f'.repeat(64),
  expiresAt: '2026-11-21T13:00:00Z',
  approvedByUserId: '99999999-8888-7777-6666-555555555555',
};
const expected = { proposalId: base.proposalId, toolName: base.toolName, argsHash: base.argsHash };

describe('approval tokens', () => {
  it('round-trips the exact claims a human approved', () => {
    const { token, claims } = mintApprovalToken(SECRET, base);
    expect(claims).toEqual(base);
    const result = verifyApprovalToken({ secret: SECRET, token, now: NOW, expected });
    expect(result).toEqual({ ok: true, claims: base });
  });

  it('is deterministic for the same claims and secret', () => {
    expect(mintApprovalToken(SECRET, base).token).toBe(mintApprovalToken(SECRET, base).token);
  });

  it('refuses a token signed with another secret', () => {
    const { token } = mintApprovalToken('b'.repeat(48), base);
    expect(verifyApprovalToken({ secret: SECRET, token, now: NOW, expected })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses tampering with any single field — the signature covers all of them', () => {
    const { token } = mintApprovalToken(SECRET, base);
    const [payloadB64, sigB64] = token.split('.') as [string, string];
    const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    for (const [from, to] of [
      [base.toolName, 'propose_charge'],
      [base.argsHash, 'e'.repeat(64)],
      [base.expiresAt, '2030-01-01T00:00:00Z'],
      [base.approvedByUserId, '00000000-0000-0000-0000-000000000000'],
    ] as [string, string][]) {
      const forged = Buffer.from(payload.replace(from, to), 'utf8').toString('base64url');
      const result = verifyApprovalToken({
        secret: SECRET,
        token: `${forged}.${sigB64}`,
        now: NOW,
        expected,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('bad_signature');
    }
  });

  it('refuses an expired token even when the signature is valid', () => {
    const { token } = mintApprovalToken(SECRET, base);
    const later = new Date('2026-11-21T13:00:01Z');
    expect(verifyApprovalToken({ secret: SECRET, token, now: later, expected })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a valid token presented for different arguments', () => {
    const { token } = mintApprovalToken(SECRET, base);
    const otherArgs = { ...expected, argsHash: 'd'.repeat(64) };
    expect(verifyApprovalToken({ secret: SECRET, token, now: NOW, expected: otherArgs })).toEqual({
      ok: false,
      reason: 'args_mismatch',
    });
    const otherProposal = { ...expected, proposalId: '22222222-3333-4444-5555-666666666666' };
    expect(
      verifyApprovalToken({ secret: SECRET, token, now: NOW, expected: otherProposal }),
    ).toEqual({ ok: false, reason: 'proposal_mismatch' });
    const otherTool = { ...expected, toolName: 'propose_charge' };
    expect(verifyApprovalToken({ secret: SECRET, token, now: NOW, expected: otherTool })).toEqual({
      ok: false,
      reason: 'tool_mismatch',
    });
  });

  it('rejects structurally broken tokens instead of throwing', () => {
    for (const token of ['', 'x', 'a.b.c', 'not-base64.not-base64']) {
      const result = verifyApprovalToken({ secret: SECRET, token, now: NOW, expected });
      expect(result.ok).toBe(false);
    }
  });

  it('refuses to mint with a secret too short to be a signature', () => {
    expect(() => mintApprovalToken('short', base)).toThrow(/at least 32/);
  });

  it('refuses claims that would make the canonical form ambiguous', () => {
    expect(() => mintApprovalToken(SECRET, { ...base, toolName: 'propose|payment' })).toThrow(
      /must not contain/,
    );
    expect(() => mintApprovalToken(SECRET, { ...base, argsHash: '' })).toThrow(/must not be empty/);
  });
});
