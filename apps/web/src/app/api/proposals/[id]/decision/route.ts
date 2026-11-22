import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { decideProposal } from '@/lib/approvals/execute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ decision: z.enum(['approve', 'reject']) });

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getSessionUser();
  if (user === null) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: 'body must be {"decision":"approve"|"reject"}' },
      { status: 400 },
    );

  const { id } = await context.params;
  try {
    const outcome = await decideProposal({
      proposalId: id,
      organizationId: user.orgId,
      userId: user.id,
      role: user.role,
      decision: parsed.data.decision,
    });
    // A recorded signature that is still short of a second key is not an error
    // and not an execution: 202 says "accepted, nothing happened yet".
    const status = outcome.status === 'awaiting_approval' ? 202 : 200;
    return NextResponse.json(outcome, { status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'decision failed';
    const notFound = /not found/.test(message);
    // A deterministic policy refusal is not a server fault: the caller is not
    // allowed to do this, and the message says which rule stopped it.
    const denied = message.startsWith('policy denied');
    const conflict = /already |do not match|expired/i.test(message);
    const status = notFound ? 404 : denied ? 403 : conflict ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
