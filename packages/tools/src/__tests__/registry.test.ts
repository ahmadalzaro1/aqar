import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { registry, toolDefs } from '../index.js';
import {
  makeRegistry,
  rawShape,
  toParameters,
  ToolNotFoundError,
  type ToolDef,
} from '../registry.js';

/** A context that must never be used: these tests stop at the validation layer. */
const unreachable: ToolContext = {
  sql: new Proxy({} as ToolContext['sql'], {
    apply() {
      throw new Error('SQL must not run in a registry unit test');
    },
    get() {
      throw new Error('SQL must not run in a registry unit test');
    },
  }),
  org: {
    id: '00000000-0000-0000-0000-000000000000',
    slug: 'test',
    name: 'Test',
    timezone: 'Asia/Amman',
    currency: 'JOD',
  },
  now: () => new Date('2026-01-01T00:00:00Z'),
};

describe('tool registry', () => {
  it('every tool is fully described and uniquely named', () => {
    const names = toolDefs.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const tool of toolDefs) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(['read', 'propose']).toContain(tool.kind);
      expect(tool.schema).toBeDefined();
    }
  });

  it('exposes the read tools the chat panel depends on', () => {
    const read = registry.list('read').map((t) => t.name);
    for (const expected of [
      'aqar_context',
      'portfolio_summary',
      'list_vacant_units',
      'list_expiring_leases',
      'search_tenants',
      'list_arrears',
      'tenant_statement',
      'list_open_tickets',
      'get_ticket',
    ]) {
      expect(read).toContain(expected);
    }
    expect(registry.list('propose')).toHaveLength(0);
  });

  it('parameters are JSON Schema a model can read — object, no $schema noise', () => {
    for (const tool of toolDefs) {
      const params = toParameters(tool);
      expect(params['type']).toBe('object');
      expect(params['$schema']).toBeUndefined();
    }
    const vacant = toParameters(registry.get('list_vacant_units'));
    expect(Object.keys(vacant['properties'] as Record<string, unknown>)).toContain('limit');
  });

  it('rawShape returns the zod shape for the MCP adapter', () => {
    const shape = rawShape(registry.get('list_vacant_units'));
    expect(shape['limit']).toBeDefined();
    expect(rawShape({ ...registry.get('list_vacant_units'), schema: z.string() })).toEqual({});
  });

  it('an unknown tool is refused, not guessed at', async () => {
    await expect(registry.run('no_such_tool', {}, unreachable)).rejects.toBeInstanceOf(
      ToolNotFoundError,
    );
    expect(() => registry.get('no_such_tool')).toThrow(ToolNotFoundError);
  });

  it('arguments are validated before any SQL runs', async () => {
    await expect(
      registry.run('list_vacant_units', { propertyId: 'not-a-uuid' }, unreachable),
    ).rejects.toThrow(/uuid/i);
    await expect(
      registry.run('list_open_tickets', { olderThanHours: -5 }, unreachable),
    ).rejects.toThrow();
  });

  it('a registry can be built from an arbitrary subset', async () => {
    const probe: ToolDef = {
      name: 'probe',
      kind: 'read',
      title: 'Probe',
      description: 'A tool used only by this test.',
      schema: z.object({ n: z.number().int().default(1) }),
      async run(_ctx, raw) {
        return { n: (raw as { n: number }).n };
      },
    };
    const small = makeRegistry([probe]);
    await expect(small.run('probe', { n: 7 }, unreachable)).resolves.toEqual({ n: 7 });
    expect(small.list()).toHaveLength(1);
  });
});
