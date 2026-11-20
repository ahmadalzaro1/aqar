// Bilingual copy for the owner-statement console.
// Own dictionary module: the shared i18n catalogue belongs to another lane and
// stays read-only, so `/statements` carries its own strings.
import type { Locale } from '@aqar/contracts';

export interface StatementStrings {
  readonly title: string;
  readonly subtitle: string;
  readonly print: string;
  readonly property: string;
  readonly owner: string;
  readonly period: string;
  readonly preview: string;
  readonly prevPeriod: string;
  readonly nextPeriod: string;
  readonly refresh: string;
  readonly rentSection: string;
  readonly rentHint: string;
  readonly colUnit: string;
  readonly colBilled: string;
  readonly colCollected: string;
  readonly colPercent: string;
  readonly tenant: string;
  readonly emptyRent: string;
  readonly deductions: string;
  readonly feeLine: string;
  readonly feeRate: string;
  readonly feeRecorded: string;
  readonly feeComputed: string;
  readonly expensesLine: string;
  readonly expensesHint: string;
  readonly emptyExpenses: string;
  readonly reserveLine: string;
  readonly grossCollected: string;
  readonly billedRent: string;
  readonly collectionRate: string;
  readonly netLine: string;
  readonly shareSection: string;
  readonly shareOwnership: string;
  readonly shareAmount: string;
  readonly shareTotal: string;
  readonly distributionPreview: string;
  readonly distributionHint: string;
  readonly totalRow: string;
  readonly ownerNoShare: string;
  readonly issuedBadge: string;
  readonly issuedOn: string;
  readonly issueTitle: string;
  readonly issueHint: string;
  readonly issueButton: string;
  readonly issuePending: string;
  readonly issueDone: string;
  readonly issueExisting: string;
  readonly issueBlocked: string;
  readonly issueError: string;
  readonly issueDrafts: string;
  readonly blockedTitle: string;
  readonly blockedShortfall: string;
  readonly blockedNoOwners: string;
  readonly blockedInvalidShares: string;
  readonly footnote: string;
  readonly readOnly: string;
}

const EN: StatementStrings = {
  title: 'Owner statement',
  subtitle: 'Itemized rent, deductions, net and this owner’s share for one property and period.',
  print: 'Print',
  property: 'Property',
  owner: 'Owner',
  period: 'Period',
  preview: 'Preview',
  prevPeriod: 'Previous period',
  nextPeriod: 'Next period',
  refresh: 'Reload statement',
  rentSection: 'Rent collected in the period',
  rentHint: 'Rent charged per lease for this period, and the payment allocations received against each charge.',
  colUnit: 'Unit / tenant',
  colBilled: 'Billed',
  colCollected: 'Collected',
  colPercent: 'Share',
  tenant: 'Tenant',
  emptyRent: 'No rent charges were raised for this property in this period.',
  deductions: 'Deductions from collections',
  feeLine: 'Management fee',
  feeRate: 'of rent collected',
  feeRecorded: 'rate carried from the last recorded fee schedule',
  feeComputed: 'default rate — no fee schedule recorded yet',
  expensesLine: 'Property expenses',
  expensesHint: 'Completed maintenance charged to this property inside the period.',
  emptyExpenses: 'No completed work orders were charged to this property in this period.',
  reserveLine: 'Reserve top-up',
  grossCollected: 'Gross rent collected',
  billedRent: 'Rent billed (for reference)',
  collectionRate: 'Collection rate',
  netLine: 'Net distributable',
  shareSection: 'Owner share of the net',
  shareOwnership: 'Ownership',
  shareAmount: 'Share of net',
  shareTotal: 'All owners',
  distributionPreview: 'Distribution drafts (not approved)',
  distributionHint: 'Issuing creates these rows as drafts only — approving and paying them is a separate human step.',
  totalRow: 'Total',
  ownerNoShare: 'This owner holds no share in the selected property, so the statement shows no share.',
  issuedBadge: 'Issued',
  issuedOn: 'Issued on',
  issueTitle: 'Issue statement',
  issueHint: 'Previewing is read-only. Issuing writes the statement, its draft distributions and an append-only audit event.',
  issueButton: 'Issue statement',
  issuePending: 'Issuing…',
  issueDone: 'Statement issued and audited.',
  issueExisting: 'Already issued — the existing statement was returned. Nothing was written twice.',
  issueBlocked: 'Resolve the block above before issuing.',
  issueError: 'The statement was not issued.',
  issueDrafts: 'Draft distributions created',
  blockedTitle: 'This statement cannot be issued',
  blockedShortfall: 'Collections do not cover the management fee plus expenses. The owner must fund the shortfall, or the fee/expense inputs must be corrected — the waterfall never pays a negative amount.',
  blockedNoOwners: 'No ownership shares are recorded for this property, so no net can be attributed.',
  blockedInvalidShares: 'The ownership shares do not sum to exactly 10000 basis points, so the net cannot be split without losing fils.',
  footnote: 'Computed from the ledger: collected rent − management fee − expenses − reserve = net, then the net is split across the ownership shares by largest remainder in whole fils. Nothing on this page is stored until a human issues it.',
  readOnly: 'Preview — read-only',
};

const AR: StatementStrings = {
  title: 'كشف المالك',
  subtitle: 'بيان مفصّل للإيجارات والاستقطاعات والصافي وحصة هذا المالك، لعقار وفترة واحدة.',
  print: 'طباعة',
  property: 'العقار',
  owner: 'المالك',
  period: 'الفترة',
  preview: 'عرض',
  prevPeriod: 'الفترة السابقة',
  nextPeriod: 'الفترة التالية',
  refresh: 'تحديث الكشف',
  rentSection: 'الإيجارات المحصّلة في الفترة',
  rentHint: 'الإيجار المستحق على كل عقد في هذه الفترة، والمبالغ المخصّصة له من الدفعات المستلمة.',
  colUnit: 'الوحدة / المستأجر',
  colBilled: 'المستحق',
  colCollected: 'المحصّل',
  colPercent: 'النسبة',
  tenant: 'المستأجر',
  emptyRent: 'لا توجد رسوم إيجار على هذا العقار في هذه الفترة.',
  deductions: 'الاستقطاعات من المحصّل',
  feeLine: 'رسوم الإدارة',
  feeRate: 'من الإيجار المحصّل',
  feeRecorded: 'النسبة مأخوذة من آخر جدول رسوم مسجَّل',
  feeComputed: 'النسبة الافتراضية — لا يوجد جدول رسوم مسجَّل بعد',
  expensesLine: 'مصاريف العقار',
  expensesHint: 'أعمال صيانة مكتملة ومحمَّلة على هذا العقار خلال الفترة.',
  emptyExpenses: 'لا توجد أوامر عمل مكتملة محمَّلة على هذا العقار في هذه الفترة.',
  reserveLine: 'تغذية الاحتياطي',
  grossCollected: 'إجمالي الإيجار المحصّل',
  billedRent: 'الإيجار المستحق (للمرجع)',
  collectionRate: 'نسبة التحصيل',
  netLine: 'الصافي القابل للتوزيع',
  shareSection: 'حصة المالك من الصافي',
  shareOwnership: 'نسبة الملكية',
  shareAmount: 'الحصة من الصافي',
  shareTotal: 'جميع المالكين',
  distributionPreview: 'مسودات التوزيع (غير معتمدة)',
  distributionHint: 'الإصدار ينشئ هذه السجلات كمسودات فقط — الاعتماد والدفع خطوة بشرية منفصلة.',
  totalRow: 'المجموع',
  ownerNoShare: 'لا يملك هذا المالك حصة في العقار المحدد، لذلك لا تظهر حصة في الكشف.',
  issuedBadge: 'صادر',
  issuedOn: 'تاريخ الإصدار',
  issueTitle: 'إصدار الكشف',
  issueHint: 'المعاينة للقراءة فقط. الإصدار يكتب الكشف ومسودات التوزيع وحدث تدقيق غير قابل للتعديل.',
  issueButton: 'إصدار الكشف',
  issuePending: 'جارٍ الإصدار…',
  issueDone: 'تم إصدار الكشف وتسجيله في سجل التدقيق.',
  issueExisting: 'صادر مسبقاً — تم إرجاع الكشف القائم، ولم يُكتب شيء مرتين.',
  issueBlocked: 'عالج المانع أعلاه قبل الإصدار.',
  issueError: 'لم يتم إصدار الكشف.',
  issueDrafts: 'مسودات التوزيع المنشأة',
  blockedTitle: 'لا يمكن إصدار هذا الكشف',
  blockedShortfall: 'المحصّل لا يغطي رسوم الإدارة والمصاريف. على المالك تغطية العجز أو تصحيح مدخلات الرسوم والمصاريف — لا يصرف النظام مبلغاً سالباً.',
  blockedNoOwners: 'لا توجد حصص ملكية مسجَّلة لهذا العقار، لذلك لا يمكن نسبة صافٍ لأي مالك.',
  blockedInvalidShares: 'مجموع حصص الملكية لا يساوي 10000 نقطة أساس بالضبط، لذلك لا يمكن توزيع الصافي دون فقدان فلوس.',
  footnote: 'يُحسب من دفتر الأستاذ: الإيجار المحصّل − رسوم الإدارة − المصاريف − الاحتياطي = الصافي، ثم يُوزَّع الصافي على حصص الملكية بأكبر باقٍ وبالفلس الكامل. لا يُخزَّن أي شيء في هذه الصفحة قبل أن يصدره إنسان.',
  readOnly: 'معاينة — للقراءة فقط',
};

const CATALOGUE: Record<Locale, StatementStrings> = { en: EN, ar: AR };

export function statementStrings(locale: Locale): StatementStrings {
  return CATALOGUE[locale];
}

/** '2026-11' → 'November 2026' / 'تشرين الثاني 2026'. */
export function periodLabel(period: string, locale: Locale): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (match === null) return period;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-JO' : 'en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** ISO timestamp → locale date + time, for the "issued on" line. */
export function issuedLabel(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-JO' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Amman',
  }).format(date);
}
