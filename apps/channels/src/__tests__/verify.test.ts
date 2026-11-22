import { describe, expect, it } from 'vitest';
import {
  hmacSha256Hex,
  secureCompare,
  verifyTelegramSecret,
  verifyWhatsAppSignature,
  whatsAppSignature,
} from '../verify.js';

/**
 * Known-answer vector computed independently of this codebase:
 *
 *   node -e "const {createHmac}=require('crypto');
 *            console.log(createHmac('sha256','wa-app-secret-KAT-2026')
 *              .update('{\"object\":\"whatsapp_business_account\",\"entry\":[]}','utf8')
 *              .digest('hex'))"
 *   → 6ca2d9bba4098c78a3c7613218381c9d40987e50f72c3a48459457ff0460bd58
 */
const KAT_SECRET = 'wa-app-secret-KAT-2026';
const KAT_BODY = '{"object":"whatsapp_business_account","entry":[]}';
const KAT_HEX = '6ca2d9bba4098c78a3c7613218381c9d40987e50f72c3a48459457ff0460bd58';

describe('WhatsApp X-Hub-Signature-256 verification', () => {
  it('reproduces the published HMAC-SHA256 known answer', () => {
    expect(hmacSha256Hex(KAT_SECRET, KAT_BODY)).toBe(KAT_HEX);
    expect(whatsAppSignature(KAT_SECRET, KAT_BODY)).toBe(`sha256=${KAT_HEX}`);
  });

  it('accepts the exact signature Meta would send', () => {
    expect(
      verifyWhatsAppSignature({
        rawBody: KAT_BODY,
        header: `sha256=${KAT_HEX}`,
        appSecret: KAT_SECRET,
      }),
    ).toBe(true);
  });

  it('accepts signatures computed over non-ASCII bytes (Arabic body)', () => {
    const body = JSON.stringify({ text: 'تسرب مياه في الحمام' });
    const header = whatsAppSignature(KAT_SECRET, body);
    expect(verifyWhatsAppSignature({ rawBody: body, header, appSecret: KAT_SECRET })).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const header = whatsAppSignature('some-other-secret', KAT_BODY);
    expect(verifyWhatsAppSignature({ rawBody: KAT_BODY, header, appSecret: KAT_SECRET })).toBe(
      false,
    );
  });

  it('rejects a tampered body that reuses a valid signature', () => {
    const header = whatsAppSignature(KAT_SECRET, KAT_BODY);
    expect(
      verifyWhatsAppSignature({
        rawBody: `${KAT_BODY} `,
        header,
        appSecret: KAT_SECRET,
      }),
    ).toBe(false);
    expect(
      verifyWhatsAppSignature({
        rawBody: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'x' }] }),
        header,
        appSecret: KAT_SECRET,
      }),
    ).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(
      verifyWhatsAppSignature({ rawBody: KAT_BODY, header: undefined, appSecret: KAT_SECRET }),
    ).toBe(false);
    expect(
      verifyWhatsAppSignature({ rawBody: KAT_BODY, header: null, appSecret: KAT_SECRET }),
    ).toBe(false);
    expect(verifyWhatsAppSignature({ rawBody: KAT_BODY, header: '', appSecret: KAT_SECRET })).toBe(
      false,
    );
  });

  it('rejects malformed headers (missing prefix, wrong length, non-hex)', () => {
    for (const header of [
      KAT_HEX, // no `sha256=` prefix
      `sha1=${KAT_HEX}`,
      'sha256=',
      'sha256=deadbeef',
      `sha256=${'z'.repeat(64)}`,
      `sha256=${KAT_HEX.slice(0, 63)}`,
    ]) {
      expect(verifyWhatsAppSignature({ rawBody: KAT_BODY, header, appSecret: KAT_SECRET })).toBe(
        false,
      );
    }
  });

  it('fails closed when the app secret is not configured', () => {
    // Even a signature computed with the empty key must not be trusted.
    const header = whatsAppSignature('', KAT_BODY);
    expect(verifyWhatsAppSignature({ rawBody: KAT_BODY, header, appSecret: '' })).toBe(false);
  });
});

describe('Telegram secret-token verification', () => {
  const secret = 'telegram-secret-token-abc123';

  it('accepts the configured token', () => {
    expect(verifyTelegramSecret({ header: secret, webhookSecret: secret })).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    const wrong = `${secret.slice(0, -1)}X`;
    expect(wrong.length).toBe(secret.length);
    expect(verifyTelegramSecret({ header: wrong, webhookSecret: secret })).toBe(false);
  });

  it('rejects a token of different length and a missing header', () => {
    expect(verifyTelegramSecret({ header: `${secret}extra`, webhookSecret: secret })).toBe(false);
    expect(verifyTelegramSecret({ header: secret.slice(0, 5), webhookSecret: secret })).toBe(false);
    expect(verifyTelegramSecret({ header: undefined, webhookSecret: secret })).toBe(false);
    expect(verifyTelegramSecret({ header: '', webhookSecret: secret })).toBe(false);
  });

  it('fails closed when no webhook secret is configured', () => {
    expect(verifyTelegramSecret({ header: '', webhookSecret: '' })).toBe(false);
    expect(verifyTelegramSecret({ header: 'anything', webhookSecret: '' })).toBe(false);
  });
});

describe('secureCompare (timing-safe primitive)', () => {
  it('returns true only for byte-identical non-empty strings', () => {
    expect(secureCompare('abc123', 'abc123')).toBe(true);
    expect(secureCompare('abc123', 'abc124')).toBe(false);
    expect(secureCompare('abc123', 'abc1234')).toBe(false);
    expect(secureCompare('', '')).toBe(false);
    expect(secureCompare('a', '')).toBe(false);
  });

  it('compares multi-byte UTF-8 by bytes, not code units', () => {
    expect(secureCompare('سر', 'سر')).toBe(true);
    expect(secureCompare('سر', 'سن')).toBe(false);
  });
});
