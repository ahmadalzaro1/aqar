'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { login } from '@/lib/auth';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});

export interface LoginState {
  error: string | null;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    totp: formData.get('totp') ?? undefined,
  });
  if (!parsed.success) return { error: 'login.error.required' };
  const totp = parsed.data.totp;
  const result = await login(
    parsed.data.email,
    parsed.data.password,
    totp === undefined || totp === '' ? null : totp,
  );
  if (!result.ok)
    return { error: result.error === 'totp' ? 'login.error.totp' : 'login.error.invalid' };
  redirect('/dashboard');
}
