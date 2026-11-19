import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { verify } from '@node-rs/argon2';
import * as OTPAuth from 'otpauth';
import { sql } from './db';

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  orgId: string;
  nameEn: string;
  nameAr: string;
}

const COOKIE = 'aqar_session';
const MONEY_ROLES = new Set(['owner_admin', 'accountant', 'property_manager']);

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function login(
  email: string,
  password: string,
  totpCode: string | null,
): Promise<{ ok: true } | { ok: false; error: 'invalid' | 'totp' }> {
  const rows = await sql`
    SELECT id, email, password_hash, role, org_id, totp_secret, name_en, name_ar
    FROM users WHERE email = ${email} LIMIT 1`;
  const user = rows[0];
  if (user === undefined) return { ok: false, error: 'invalid' };
  let passwordOk = false;
  try {
    passwordOk = await verify(String(user['password_hash']), password);
  } catch {
    passwordOk = false;
  }
  if (!passwordOk) return { ok: false, error: 'invalid' };
  const secret = user['totp_secret'];
  if (typeof secret === 'string' && secret.length > 0 && MONEY_ROLES.has(String(user['role']))) {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 });
    const delta = totp.validate({ token: totpCode ?? '', window: 1 });
    if (delta === null) return { ok: false, error: 'totp' };
  }
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await sql`
    INSERT INTO sessions (id, token_hash, user_id, expires_at)
    VALUES (${randomBytes(16).toString('hex')}, ${sha256(token)}, ${String(user['id'])}, ${expires})`;
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: 7 * 24 * 3600,
  });
  return { ok: true };
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token === undefined) return null;
  const rows = await sql`
    SELECT u.id, u.email, u.role, u.org_id, u.name_en, u.name_ar
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256(token)} AND s.expires_at > now() LIMIT 1`;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: String(r['id']), email: String(r['email']), role: String(r['role']),
    orgId: String(r['org_id']), nameEn: String(r['name_en']), nameAr: String(r['name_ar']),
  };
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token !== undefined) {
    await sql`DELETE FROM sessions WHERE token_hash = ${sha256(token)}`;
    store.delete(COOKIE);
  }
}
