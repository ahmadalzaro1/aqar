import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { PolicyDeniedError } from '@aqar/core';
import { reverseProposal } from '@/lib/approvals/reverse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ reason: z.string().min(10, 'a reversal needs a reason') });

/**
 * POST /api/proposals/[id]/reversal — undo an executed proposal.
 *
 * The reason is mandatory and stored: a reversal nobody can explain later is
 * indistinguishable from a mistake being covered up.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getSessionUser();
  if (user === null) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'body must be {"reason":"<at least 10 characters>"}' },
      { status: 400 },
    );

  const { id } = await context.params;
  try {
    const outcome = await reverseProposal({
      proposalId: id,
      organizationId: user.orgId,
      userId: user.id,
      role: user.role,
      reason: parsed.data.reason,
    });
    return NextResponse.json(outcome, { status: outcome.status === 'reversed' ? 200 : 409 });
  } catch (err) {
    // The service decides; the route only maps. A policy refusal carries its own
    // evidence, so nothing here matches on message text to find the status.
    if (err instanceof PolicyDeniedError) {
      return NextResponse.json(
        { error: err.message, policy: { version: err.version, decisive: err.decision.decisive } },
        { status: 403 },
      );
    }
    const message = err instanceof Error ? err.message : 'reversal failed';
    const notFound = /not found/.test(message);
    const conflict = /already |only an executed|needs a reason/i.test(message);
    const status = notFound ? 404 : conflict ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
