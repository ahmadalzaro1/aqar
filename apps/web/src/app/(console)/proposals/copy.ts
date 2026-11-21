// The console's locale mechanism is the `aqar_locale` cookie read through
// `getLocale()` in '@/i18n/server'. Console pages that need strings outside the
// shared catalogue keep their own per-locale dictionary next to the page (see
// components/ChatDock.tsx); this page does the same rather than editing the
// shared i18n files.
import type { Locale } from '@aqar/contracts';

export interface Strings {
  readonly title: string;
  readonly hint: string;
  readonly pendingTitle: string;
  readonly pendingCount: (n: number) => string;
  readonly decidedTitle: string;
  readonly emptyPendingTitle: string;
  readonly emptyPendingHint: string;
  readonly emptyDecidedTitle: string;
  readonly emptyDecidedHint: string;
  readonly action: string;
  readonly tool: string;
  readonly args: string;
  readonly created: string;
  readonly expires: string;
  readonly model: string;
  readonly summary: string;
  readonly status: string;
  readonly decidedAt: string;
  readonly decidedBy: string;
  readonly outcome: string;
  readonly approve: string;
  readonly reject: string;
  readonly approving: string;
  readonly rejecting: string;
  readonly decidedLabel: string;
  readonly result: string;
  readonly reason: string;
  readonly errorLabel: string;
  readonly pastExpiry: string;
  readonly justDecided: string;
  readonly cannotDecide: string;
  readonly system: string;
  readonly actions: Record<string, string>;
  readonly statuses: Record<string, string>;
}

const en: Strings = {
  title: 'Proposals',
  hint: 'Nothing moves money or messages a tenant until a human decides here. Approving runs the action against the database.',
  pendingTitle: 'Awaiting your decision',
  pendingCount: (n) => `${n} pending`,
  decidedTitle: 'Recently decided',
  emptyPendingTitle: 'No proposals are waiting',
  emptyPendingHint: 'Consequential actions requested by the agent queue here for a human decision.',
  emptyDecidedTitle: 'Nothing decided yet',
  emptyDecidedHint: 'The last ten decisions will appear here once someone approves or rejects a proposal.',
  action: 'Action',
  tool: 'Tool',
  args: 'Arguments',
  created: 'Created',
  expires: 'Expires',
  model: 'Model',
  summary: 'Summary',
  status: 'Status',
  decidedAt: 'Decided',
  decidedBy: 'Decided by',
  outcome: 'Outcome',
  approve: 'Approve',
  reject: 'Reject',
  approving: 'Approving…',
  rejecting: 'Rejecting…',
  decidedLabel: 'Decided',
  result: 'Execution result',
  reason: 'Reason',
  errorLabel: 'Error',
  pastExpiry: 'Past expiry',
  justDecided: 'Decided in this session',
  cannotDecide: 'Your role cannot approve. Only an owner admin, accountant or property manager can decide.',
  system: 'System',
  actions: {
    post_payment: 'Post payment',
    dispatch_vendor: 'Dispatch vendor',
    send_tenant_message: 'Message tenant',
    create_units_from_plan: 'Create units',
  },
  statuses: {
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    expired: 'Expired',
    executed: 'Executed',
    failed: 'Failed',
  },
};

const ar: Strings = {
  title: 'المقترحات',
  hint: 'لا تُسجَّل أي دفعة ولا تُرسَل أي رسالة إلى مستأجر قبل قرار بشري هنا. الموافقة تنفّذ الإجراء على قاعدة البيانات.',
  pendingTitle: 'بانتظار قرارك',
  pendingCount: (n) => `${n} بانتظار القرار`,
  decidedTitle: 'قرارات حديثة',
  emptyPendingTitle: 'لا توجد مقترحات معلّقة',
  emptyPendingHint: 'تُعرض هنا إجراءات الوكيل ذات الأثر التي تنتظر قراراً بشرياً.',
  emptyDecidedTitle: 'لا توجد قرارات بعد',
  emptyDecidedHint: 'ستظهر هنا آخر عشرة قرارات بعد أن يوافق أحدهم أو يرفض مقترحاً.',
  action: 'الإجراء',
  tool: 'الأداة',
  args: 'المدخلات',
  created: 'أُنشئ',
  expires: 'ينتهي',
  model: 'النموذج',
  summary: 'الملخص',
  status: 'الحالة',
  decidedAt: 'تاريخ القرار',
  decidedBy: 'صاحب القرار',
  outcome: 'النتيجة',
  approve: 'موافقة',
  reject: 'رفض',
  approving: 'جارٍ التنفيذ…',
  rejecting: 'جارٍ الرفض…',
  decidedLabel: 'تم البت',
  result: 'نتيجة التنفيذ',
  reason: 'السبب',
  errorLabel: 'خطأ',
  pastExpiry: 'تجاوز المهلة',
  justDecided: 'قرارات هذه الجلسة',
  cannotDecide: 'دورك لا يسمح بالموافقة. الأدوار المصرّح لها: مدير المالك، المحاسب، مدير العقارات.',
  system: 'النظام',
  actions: {
    post_payment: 'تسجيل دفعة',
    dispatch_vendor: 'إرسال مورّد',
    send_tenant_message: 'مراسلة مستأجر',
    create_units_from_plan: 'إنشاء وحدات',
  },
  statuses: {
    pending: 'قيد الانتظار',
    approved: 'معتمد',
    rejected: 'مرفوض',
    expired: 'منتهي',
    executed: 'منفّذ',
    failed: 'فشل',
  },
};

// Single dictionary per locale; `Locale` is exactly 'ar' | 'en'.
const COPY: Record<Locale, Strings> = { en, ar };

export function stringsFor(locale: Locale): Strings {
  return COPY[locale];
}
