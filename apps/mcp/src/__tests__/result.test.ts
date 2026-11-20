import { describe, expect, it } from 'vitest';
import { guarded, fail, ok } from '../result.js';
import { ToolError } from '../errors.js';

function parse(result: { content: unknown[] }): Record<string, unknown> {
  const first = result.content[0] as { type: string; text: string };
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('ok', () => {
  it('returns the payload as pretty JSON in a single text block', () => {
    const result = ok({ ticketId: 't1', emergency: true });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(parse(result)).toEqual({ ticketId: 't1', emergency: true });
  });

  it('prefixes an optional note so the model reads the warning before the data', () => {
    const result = ok({ ok: true }, 'The ledger has NOT changed.');
    const block = result.content[0] as { text: string };
    expect(block.text.startsWith('The ledger has NOT changed.')).toBe(true);
    expect(block.text).toContain('"ok": true');
  });

  it('serialises integer fils exactly — no float drift on money', () => {
    const result = ok({ amountFils: 250000, amountJod: '250.000' });
    const block = result.content[0] as { text: string };
    expect(block.text).toContain('"amountFils": 250000');
  });
});

describe('fail', () => {
  it('marks the result as an error and carries the machine-readable code', () => {
    const result = fail(new ToolError('not_found', 'No ticket in this organization', 'Check the id.'));
    expect(result.isError).toBe(true);
    const payload = parse(result) as {
      ok: boolean;
      error: { code: string; message: string; hint?: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('not_found');
    expect(payload.error.hint).toBe('Check the id.');
  });

  it('omits hint entirely when there is none, instead of sending null', () => {
    const body = parse(fail(new ToolError('policy_denied', 'Denied'))) as {
      error: Record<string, unknown>;
    };
    expect('hint' in body.error).toBe(false);
  });

  it('maps an unexpected Error to internal_error without leaking a stack', () => {
    const body = parse(fail(new Error('boom'))) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('boom');
    expect(JSON.stringify(body)).not.toContain('at ');
  });
});

describe('guarded', () => {
  it('passes a successful result through untouched', async () => {
    const handler = guarded(async () => ok({ fine: true }));
    const result = await handler({});
    expect(result.isError).toBeUndefined();
  });

  it('converts a thrown error into an MCP error result instead of a transport failure', async () => {
    const handler = guarded(async () => {
      throw new ToolError('bad_input', 'amountFils must be an integer');
    });
    const result = await handler({});
    expect(result.isError).toBe(true);
    const body = parse(result) as { error: { code: string } };
    expect(body.error.code).toBe('bad_input');
  });
});
