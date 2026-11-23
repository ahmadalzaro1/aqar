'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { loginByEmail } from '@/lib/auth';

/**
 * Email-only sign-in. The form collects one field; the address must belong to
 * an existing, active account. Ownership of the address is proven at the edge
 * (Cloudflare Access one-time PIN) for anyone outside the owner's network.
 */
const schema = z.object({
  email: z.string().trim().email(),
});

export interface LoginState {
  error: string | null;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({ email: formData.get('email') });
  if (!parsed.success) return { error: 'login.error.required' };
  const result = await loginByEmail(parsed.data.email);
  if (!result.ok) return { error: 'login.error.invalid' };
  redirect('/dashboard');
}
