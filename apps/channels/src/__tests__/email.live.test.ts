import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type EmailConfig } from '../config.js';
import { loadRepoEnv } from '../env.js';
import { sendEmail } from '../outbound.js';

const MAILPIT_API = process.env['MAILPIT_API_URL'] ?? 'http://127.0.0.1:8025';

type MailpitMessage = {
  readonly ID: string;
  readonly MessageID: string;
  readonly Subject: string;
  readonly To?: { readonly Address: string }[];
};

type MailpitList = {
  readonly total: number;
  readonly messages?: readonly MailpitMessage[];
};

function mimeSubjectEncoded(subject: string): string {
  // nodemailer may MIME-encode a non-ASCII subject; Mailpit reports the decoded
  // value, so this is only a guard for the ASCII case we assert on.
  return subject;
}

async function findMessage(subject: string, timeoutMs = 20_000): Promise<MailpitMessage | null> {
  const deadline = Date.now() + timeoutMs;
  const wanted = mimeSubjectEncoded(subject);
  while (Date.now() < deadline) {
    const response = await fetch(`${MAILPIT_API}/api/v1/messages?limit=100`);
    if (!response.ok) {
      throw new Error(`Mailpit API returned ${response.status} — is Mailpit running on 8025?`);
    }
    const body = (await response.json()) as MailpitList;
    const hit = (body.messages ?? []).find((message) => message.Subject === wanted);
    if (hit !== undefined) return hit;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

describe('outbound email over real SMTP (Mailpit)', () => {
  let email: EmailConfig;

  beforeAll(() => {
    loadRepoEnv();
    email = loadConfig(process.env).email;
  });

  afterAll(() => {
    // Nothing to tear down: Mailpit owns its own store.
  });

  it('parses the dev SMTP URL to loopback:1025', () => {
    expect(email.smtpUrl).toContain('127.0.0.1:1025');
    expect(email.from.length).toBeGreaterThan(0);
  });

  it('delivers a message end-to-end and returns the SMTP message id', async () => {
    const subject = `aqar-channels-smtp-${randomUUID()}`;
    const text = 'طلبك وصل — السباك رح يوصلك بكرا الساعة 9:00 صباحاً.';

    const result = await sendEmail(email, { to: 'tenant@example.test', subject, text });
    expect(result.messageId.length).toBeGreaterThan(0);
    expect(result.messageId).toContain('@');
    expect(result.accepted.map((value) => value.toLowerCase())).toContain('tenant@example.test');

    const delivered = await findMessage(subject);
    expect(delivered).not.toBeNull();
    if (delivered === null) throw new Error(`Mailpit never received subject ${subject}`);
    expect(delivered.Subject).toBe(subject);
    expect(delivered.To?.map((to) => to.Address.toLowerCase())).toContain('tenant@example.test');
  });

  it('sends a second, distinct message (no cross-talk between sends)', async () => {
    const subject = `aqar-channels-smtp-${randomUUID()}`;
    const result = await sendEmail(email, {
      to: 'tenant@example.test',
      subject,
      text: 'Acknowledge: your ticket has been triaged as high severity.',
    });
    expect(result.accepted.length).toBeGreaterThan(0);
    const delivered = await findMessage(subject);
    expect(delivered?.Subject).toBe(subject);
  });
});
