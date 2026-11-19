import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages } from '@/i18n/server';
import { orgName } from '@/lib/queries';
import { Shell } from '@/components/Shell';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (user === null) redirect('/login');
  const locale = await getLocale();
  const messages = await getMessages();
  const org = await orgName(user.orgId);
  return (
    <Shell user={user} orgName={org} locale={locale} messages={messages}>
      {children}
    </Shell>
  );
}
