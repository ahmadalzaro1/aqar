import { getSessionUser } from '@/lib/auth';
import { getLocale } from '@/i18n/server';
import { listImports } from './data';
import { BankWizard } from './BankWizard';

export default async function BankPage() {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const recent = await listImports(user.orgId);
  return <BankWizard locale={locale} recent={recent} />;
}
