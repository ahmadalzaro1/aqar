// Bilingual copy for the ticket dispatch board.
// Own module, same reason as statements/dict.ts: the shared i18n catalogue
// belongs to another lane and stays read-only.
import type { Locale } from '@aqar/contracts';

export interface DispatchStrings {
  readonly title: string;
  readonly subtitle: string;
  readonly slaTitle: string;
  readonly slaResponseDue: string;
  readonly slaResolutionDue: string;
  readonly slaResponded: string;
  readonly slaResolved: string;
  readonly slaBreached: string;
  readonly slaNoClock: string;
  readonly offerTitle: string;
  readonly vendor: string;
  readonly scope: string;
  readonly scopePlaceholder: string;
  readonly nte: string;
  readonly nteHint: string;
  readonly needsApproval: string;
  readonly abovePolicyCeiling: string;
  readonly offer: string;
  readonly noVendors: string;
  readonly offersTitle: string;
  readonly workOrdersTitle: string;
  readonly quotesTitle: string;
  readonly quotesEmpty: string;
  readonly notSelected: string;
  readonly recordQuote: string;
  readonly amount: string;
  readonly leadDays: string;
  readonly notes: string;
  readonly save: string;
  readonly accept: string;
  readonly decline: string;
  readonly approve: string;
  readonly complete: string;
  readonly cost: string;
  readonly status: string;
  readonly ceiling: string;
  readonly unproven: string;
  readonly score: string;
  readonly rating: string;
  readonly overCeiling: string;
  readonly working: string;
  readonly errors: Readonly<Record<string, string>>;
}

const en: DispatchStrings = {
  title: 'Dispatch',
  subtitle: 'Offer the job to a trade vendor, record their price, and close it with the real cost.',
  slaTitle: 'Service clock',
  slaResponseDue: 'Response due',
  slaResolutionDue: 'Resolution due',
  slaResponded: 'Responded',
  slaResolved: 'Resolved',
  slaBreached: 'breached',
  slaNoClock: 'No clock yet — one is created with the first offer.',
  offerTitle: 'Offer to a vendor',
  vendor: 'Vendor',
  scope: 'Scope of work',
  scopePlaceholder: 'What must be done, and what is explicitly excluded.',
  nte: 'Ceiling (JOD)',
  nteHint: 'The most the agency authorises. Above the limit the offer is held for approval.',
  needsApproval: 'Above the approval limit — this will be saved as a draft, not sent.',
  abovePolicyCeiling:
    'Above the policy ceiling for a single work order — split the job or raise the policy first.',
  offer: 'Offer',
  noVendors: 'No allow-listed vendor covers this trade yet. Add one in the vendor roster.',
  offersTitle: 'Offers',
  workOrdersTitle: 'Work orders',
  quotesTitle: 'Quotes received',
  quotesEmpty: 'No quotes recorded yet.',
  notSelected: 'not selected',
  recordQuote: 'Record a quote',
  amount: 'Amount (JOD)',
  leadDays: 'Lead time (days)',
  notes: 'Notes',
  save: 'Save',
  accept: 'Accepted',
  decline: 'Declined',
  approve: 'Approve and send',
  complete: 'Record completion',
  cost: 'Actual cost (JOD)',
  status: 'status',
  ceiling: 'ceiling',
  unproven: 'unproven',
  score: 'score',
  rating: 'rating',
  overCeiling: 'over the authorised ceiling',
  working: 'Working…',
  errors: {
    scope_too_short: 'Scope is too short — say what must be done.',
    nte_not_a_number: 'Ceiling must be a number like 75 or 75.500.',
    ticket_not_found: 'Ticket not found.',
    ticket_already_closed: 'This ticket is closed.',
    work_order_open: 'A work order is already open on this ticket.',
    already_offered: 'This vendor already has an offer on this ticket.',
    above_policy_ceiling: 'Above the policy ceiling for a single work order.',
    work_order_not_found: 'Work order not found.',
    not_a_draft: 'Only a draft can be approved.',
    dispatch_not_found: 'Offer not found.',
    not_offered: 'This offer is no longer open.',
    amount_not_a_number: 'Amount must be a number like 45 or 45.500.',
    lead_time_out_of_range: 'Lead time must be 0–365 days.',
    cost_not_a_number: 'Cost must be a number like 60 or 60.250.',
    already_completed: 'This work order is already completed.',
    unauthorized: 'Your session expired — sign in again.',
  },
};

const ar: DispatchStrings = {
  title: 'الإرسال للمقاول',
  subtitle: 'أرسل الطلب إلى فني مختص، سجّل سعره، وأغلق المهمة بالكلفة الفعلية.',
  slaTitle: 'عدّاد الخدمة',
  slaResponseDue: 'الاستجابة مستحقة',
  slaResolutionDue: 'الحل مستحق',
  slaResponded: 'تمّت الاستجابة',
  slaResolved: 'تمّ الحل',
  slaBreached: 'متأخر',
  slaNoClock: 'لا يوجد عدّاد بعد — يُنشأ مع أول إرسال.',
  offerTitle: 'الإرسال إلى مقاول',
  vendor: 'المقاول',
  scope: 'نطاق العمل',
  scopePlaceholder: 'ما يجب تنفيذه، وما هو مستثنى صراحةً.',
  nte: 'السقف (دينار)',
  nteHint: 'أقصى ما تلتزم به الإدارة. فوق الحد يُحفظ الطلب كمسوّدة ولا يُرسل.',
  needsApproval: 'أعلى من حد الموافقة — سيُحفظ كمسوّدة ولن يُرسل.',
  abovePolicyCeiling: 'أعلى من سقف السياسة لأمر عمل واحد — قسّم المهمة أو ارفع السقف أولاً.',
  offer: 'إرسال',
  noVendors: 'لا يوجد مقاول مدرج يغطي هذه الحرفة. أضف مقاولاً في السجل.',
  offersTitle: 'العروض المرسلة',
  workOrdersTitle: 'أوامر العمل',
  quotesTitle: 'العروض السعرية',
  quotesEmpty: 'لم تُسجَّل عروض سعرية بعد.',
  notSelected: 'غير مختار',
  recordQuote: 'تسجيل عرض سعر',
  amount: 'المبلغ (دينار)',
  leadDays: 'مدة التنفيذ (أيام)',
  notes: 'ملاحظات',
  save: 'حفظ',
  accept: 'قبل',
  decline: 'رفض',
  approve: 'اعتماد وإرسال',
  complete: 'تسجيل الإنجاز',
  cost: 'الكلفة الفعلية (دينار)',
  status: 'الحالة',
  ceiling: 'السقف',
  unproven: 'غير مُقيَّم',
  score: 'الدرجة',
  rating: 'التقييم',
  overCeiling: 'أعلى من السقف المعتمد',
  working: 'جارٍ…',
  errors: {
    scope_too_short: 'نطاق العمل قصير — اكتب ما يجب تنفيذه.',
    nte_not_a_number: 'السقف يجب أن يكون رقماً مثل 75 أو 75.500.',
    ticket_not_found: 'الطلب غير موجود.',
    ticket_already_closed: 'هذا الطلب مغلق.',
    work_order_open: 'يوجد أمر عمل مفتوح على هذا الطلب.',
    already_offered: 'هذا المقاول لديه عرض مُرسل على هذا الطلب.',
    above_policy_ceiling: 'أعلى من سقف السياسة لأمر عمل واحد.',
    work_order_not_found: 'أمر العمل غير موجود.',
    not_a_draft: 'يُعتمد فقط ما هو مسوّدة.',
    dispatch_not_found: 'العرض غير موجود.',
    not_offered: 'هذا العرض لم يعد مفتوحاً.',
    amount_not_a_number: 'المبلغ يجب أن يكون رقماً مثل 45 أو 45.500.',
    lead_time_out_of_range: 'مدة التنفيذ يجب أن تكون بين 0 و365 يوماً.',
    cost_not_a_number: 'الكلفة يجب أن تكون رقماً مثل 60 أو 60.250.',
    already_completed: 'أمر العمل منجز بالفعل.',
    unauthorized: 'انتهت الجلسة — سجّل الدخول مرة أخرى.',
  },
};

export function dispatchStrings(locale: Locale): DispatchStrings {
  return locale === 'en' ? en : ar;
}
