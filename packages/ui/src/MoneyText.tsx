import type { Locale } from '@aqar/contracts';
import { formatMoney } from './format.js';

export function MoneyText({
  fils,
  locale,
  strong = false,
}: {
  fils: number;
  locale: Locale;
  strong?: boolean;
}) {
  return (
    <span
      className="money tnum"
      style={{ fontWeight: strong ? 600 : 400, direction: 'ltr', unicodeBidi: 'isolate' }}
    >
      {formatMoney(fils, locale)}
    </span>
  );
}
