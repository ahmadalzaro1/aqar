/**
 * Approval tokens: the proof that a named human, at a specific moment, approved
 * one specific action with one specific argument set.
 *
 * Why a signature and not just a boolean column: the row can be edited by any
 * process that can reach the database, and "status = approved" says nothing about
 * *what* was approved. The token binds identity, proposal, tool, argument hash and
 * expiry into one string, so the executor can refuse a row that was approved for
 * different arguments than the ones it is about to apply.
 *
 * Canonical form is a delimited string, not JSON: a JSON payload's meaning depends
 * on key order and number formatting, and both have bitten signature schemes
 * before. None of the six fields can contain the delimiter, so this is unambiguous
 * by construction.
 *
 * `node:crypto` is a computation, not I/O: no clock, no network, no randomness.
 * The expiry is passed in by the caller; this module never reads a wall clock.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const APPROVAL_TOKEN_VERSION = 1;

export interface ApprovalClaims {
  readonly proposalId: string;
  readonly toolName: string;
  readonly argsHash: string;
  /** ISO instant. Compared against the caller's `now`, never against Date.now(). */
  readonly expiresAt: string;
  readonly approvedByUserId: string;
}

export interface MintedApproval {
  readonly token: string;
  readonly claims: ApprovalClaims;
}

export type VerifyFailure =
  | 'malformed'
  | 'bad_version'
  | 'bad_signature'
  | 'expired'
  | 'proposal_mismatch'
  | 'tool_mismatch'
  | 'args_mismatch'
  | 'approver_mismatch';

export type VerifyResult =
  | { readonly ok: true; readonly claims: ApprovalClaims }
  | { readonly ok: false; readonly reason: VerifyFailure };

const DELIMITER = '|';

function canonical(claims: ApprovalClaims): string {
  for (const [name, value] of Object.entries(claims)) {
    if (value.includes(DELIMITER)) {
      throw new Error(`approval claim ${name} must not contain '${DELIMITER}'`);
    }
    if (value.length === 0) throw new Error(`approval claim ${name} must not be empty`);
  }
  return [
    String(APPROVAL_TOKEN_VERSION),
    claims.proposalId,
    claims.toolName,
    claims.argsHash,
    claims.expiresAt,
    claims.approvedByUserId,
  ].join(DELIMITER);
}

function sign(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

function encode(buf: Buffer): string {
  return buf.toString('base64url');
}

export function mintApprovalToken(secret: string, claims: ApprovalClaims): MintedApproval {
  if (secret.length < 32) {
    throw new Error(
      'approval secret must be at least 32 characters — a short secret is not a signature',
    );
  }
  const payload = canonical(claims);
  const token = `${encode(Buffer.from(payload, 'utf8'))}.${encode(sign(secret, payload))}`;
  return { token, claims };
}

export interface VerifyOptions {
  readonly secret: string;
  readonly token: string;
  /** `now` is an input: this function is used in tests and in replay checks. */
  readonly now: Date;
  /** The row as it exists right now; a token for different arguments must fail. */
  readonly expected: {
    readonly proposalId: string;
    readonly toolName: string;
    readonly argsHash: string;
  };
}

export function verifyApprovalToken(opts: VerifyOptions): VerifyResult {
  const parts = opts.token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, signatureB64] = parts as [string, string];

  let payload: string;
  let given: Buffer;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    given = Buffer.from(signatureB64, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expectedSignature = sign(opts.secret, payload);
  if (given.length !== expectedSignature.length || !timingSafeEqual(given, expectedSignature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const fields = payload.split(DELIMITER);
  if (fields.length !== 6) return { ok: false, reason: 'malformed' };
  const [version, proposalId, toolName, argsHash, expiresAt, approvedByUserId] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== String(APPROVAL_TOKEN_VERSION)) return { ok: false, reason: 'bad_version' };

  const claims: ApprovalClaims = { proposalId, toolName, argsHash, expiresAt, approvedByUserId };

  if (proposalId !== opts.expected.proposalId) return { ok: false, reason: 'proposal_mismatch' };
  if (toolName !== opts.expected.toolName) return { ok: false, reason: 'tool_mismatch' };
  if (argsHash !== opts.expected.argsHash) return { ok: false, reason: 'args_mismatch' };

  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return { ok: false, reason: 'malformed' };
  if (expiry <= opts.now.getTime()) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}
