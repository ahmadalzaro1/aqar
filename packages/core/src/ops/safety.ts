// Immediate bilingual safety instructions, keyed by hazard signal id.
// STATIC catalogue. Never legal advice, never a responsibility determination.
// Jurisdictional / cost / liability framing always defers to a human.

import type { HazardSignalId } from './emergency.js';

export type SafetyLocale = 'ar' | 'en';

export interface SafetyInstructionSet {
  readonly ar: readonly string[];
  readonly en: readonly string[];
}

/**
 * Jordan civil defence / unified emergency number.
 * Rendered in every instruction set: a wrong number is worse than a repeated one.
 */
export const JORDAN_EMERGENCY_NUMBER = '911';

const AR_FOOTER =
  'ملاحظة: هذه إرشادات سلامة عامة وليست استشارة قانونية أو تعاقدية. المراجعة البشرية مطلوبة ' +
  'قبل أي قرار يتعلق بالمسؤولية أو التكلفة أو القانون.';

const EN_FOOTER =
  'Note: this is general safety guidance, not legal or contractual advice. Human review required ' +
  'before any responsibility, cost, or legal determination.';

/** Per hazard: immediate steps that reduce harm before a human arrives. */
export const SAFETY_INSTRUCTIONS: Readonly<Record<HazardSignalId, SafetyInstructionSet>> = {
  gas_leak: {
    ar: [
      'لا تشغّل أو تطفئ أي مفتاح كهربائي أو مصباح، ولا تستخدم الهاتف داخل المكان.',
      'افتح النوافذ والأبواب للتهوية إن كان ذلك آمناً.',
      'أغلق صمام الغاز الرئيسي إن كان في متناول يدك دون خطر.',
      'أخرج جميع السكان من الوحدة وابقوا بعيدين حتى تصل المساعدة.',
      'اتصل بالدفاع المدني على 911 وبشركة الغاز فوراً.',
    ],
    en: [
      'Do not switch any electrical switch or light on or off, and do not use a phone inside the unit.',
      'Open windows and doors to ventilate if it is safe to do so.',
      'Shut the main gas valve if you can reach it without risk.',
      'Get everyone out of the unit and stay outside until help arrives.',
      'Call civil defence on 911 and the gas utility immediately.',
    ],
  },
  gas_smell: {
    ar: [
      'لا تشغّل أو تطفئ أي مفتاح كهربائي أو مصباح، ولا تستخدم الهاتف داخل المكان.',
      'افتح النوافذ والأبواب للتهوية إن كان ذلك آمناً.',
      'أغلق صمام الغاز الرئيسي إن كان في متناول يدك دون خطر.',
      'أخرج جميع السكان من الوحدة وابقوا بعيدين حتى تصل المساعدة.',
      'اتصل بالدفاع المدني على 911 وبشركة الغاز فوراً.',
    ],
    en: [
      'Do not switch any electrical switch or light on or off, and do not use a phone inside the unit.',
      'Open windows and doors to ventilate if it is safe to do so.',
      'Shut the main gas valve if you can reach it without risk.',
      'Get everyone out of the unit and stay outside until help arrives.',
      'Call civil defence on 911 and the gas utility immediately.',
    ],
  },
  fire: {
    ar: [
      'اخرج من المكان فوراً وأغلق الباب خلفك إن كان ذلك ممكناً دون خطر.',
      'لا تستخدم المصعد أثناء الحريق.',
      'اتصل بالدفاع المدني على 911 وقدّم عنوان العقار ورقم الوحدة.',
      'لا تعد إلى الوحدة حتى تسمح فرق الدفاع المدني بذلك.',
    ],
    en: [
      'Leave immediately and close the door behind you if you can do so without risk.',
      'Do not use the elevator during a fire.',
      'Call civil defence on 911 and give the building address and unit number.',
      'Do not re-enter until civil defence clears the unit.',
    ],
  },
  smoke: {
    ar: [
      'ابقَ منخفضاً قرب الأرض وغطِّ أنفك وفمك بقماش مبلل.',
      'اخرج من الوحدة وأغلق الأبواب خلفك، ولا تستخدم المصعد.',
      'اتصل بالدفاع المدني على 911 حتى لو بدا الدخان بسيطاً.',
    ],
    en: [
      'Stay low near the floor and cover your nose and mouth with a damp cloth.',
      'Leave the unit, close doors behind you, and do not use the elevator.',
      'Call civil defence on 911 even if the smoke looks minor.',
    ],
  },
  electrical_hazard: {
    ar: [
      'لا تلمس الأسلاك أو الأجزاء المعدنية المكشوفة ولا تقترب من الماء.',
      'أطفئ القاطع الرئيسي من لوحة الكهرباء إن أمكن دون لمس الأسلاك.',
      'أبعد الأطفال عن المكان واتصل بالدفاع المدني على 911 عند وجود حريق أو صعقة.',
      'اتصل بفني كهربائي مؤهل قبل إعادة التيار.',
    ],
    en: [
      'Do not touch exposed wires or metal parts and keep clear of water.',
      'Switch off the main breaker if you can reach it without touching wiring.',
      'Keep children away and call civil defence on 911 if there is fire or a shock.',
      'Have a qualified electrician inspect before power is restored.',
    ],
  },
  sewage: {
    ar: [
      'لا تلمس مياه الصرف ولا تستخدمها للتنظيف.',
      'أغلق مصدر الماء المتسرب إن أمكن وأبعد الأطفال والحيوانات.',
      'هوِّ الغرفة وارتدِ قفازات عند التنظيف.',
      'اتصل بفريق الطوارئ على 911 إذا كان التسرب غزيراً أو قريباً من مصدر كهرباء.',
    ],
    en: [
      'Do not touch or wash with sewage water.',
      'Shut off the water source if you can reach it, and keep children and pets away.',
      'Ventilate the room and wear gloves when cleaning.',
      'Call emergency services on 911 if the backup is large or near electrical fittings.',
    ],
  },
  flooding: {
    ar: [
      'أغلق محبس الماء الرئيسي أو صمام الوحدة إن أمكن الوصول إليه بأمان.',
      'لا تقترب من الماء القريب من الأسلاك أو المقابس الكهربائية.',
      'انقل الأجهزة الكهربائية والأغراض الثمينة بعيداً عن الماء إن كان آمناً.',
      'اتصل بالدفاع المدني على 911 إذا غمر الماء مساحة كبيرة أو اقترب من الكهرباء.',
    ],
    en: [
      'Shut the main water valve or the unit valve if you can reach it safely.',
      'Stay away from water near wiring or sockets.',
      'Move electrical appliances and valuables clear of the water if it is safe.',
      'Call emergency services on 911 if water covers a large area or reaches electrics.',
    ],
  },
  no_water: {
    ar: [
      'لا تشرب ماء غير معروف المصدر ولا تستخدمه للطهي.',
      'أغلق الخلاطات والمحابس لمنع الهواء ودخول الماء الملوث عند عودة الضخ.',
      'اتصل بشركة المياه أو بإدارة العقار لتأكيد موعد الإصلاح.',
      'اتصل على 911 إذا كان الانقطاع مرتبطاً بحريق أو انهيار أو خطر على شخص.',
    ],
    en: [
      'Do not drink or cook with water of unknown source.',
      'Close taps and valves to avoid air and contaminated water when supply returns.',
      'Contact the water utility or building management to confirm the repair time.',
      'Call 911 if the outage is linked to fire, collapse, or a threat to a person.',
    ],
  },
  elevator_entrapment: {
    ar: [
      'ابقَ داخل المصعد ولا تحاول الخروج من الفتحات أو السقف.',
      'اضغط زر الإنذار ونادِ على أحد في المبنى.',
      'استخدم هاتف المصعد أو هاتفك إن كانت هناك تغطية، واتصل على 911.',
      'أخبر المشغّل بعدد الأشخاص ووجود أطفال أو حالات طبية.',
      'لا تنقل أي شخص محتجز إلى المستشفى بنفسك؛ انتظر فرقة الإنقاذ.',
    ],
    en: [
      'Stay inside the elevator and do not try to force the doors or the hatch.',
      'Press the alarm button and call out to someone in the building.',
      'Use the elevator phone or your phone if there is signal, and call 911.',
      'Tell the operator how many people are inside and whether there are children or medical cases.',
      'Do not attempt a rescue yourself; wait for the rescue crew.',
    ],
  },
  structural: {
    ar: [
      'اخرج من الوحدة والمنطقة المتأثرة فوراً دون تحميل الأسقف أو السلالم.',
      'لا تعد إلى الغرف المتصدعة حتى يفحصها مهندس مختص.',
      'اتصل بالدفاع المدني على 911 إذا كان هناك سقوط أو انهيار أو تصدع متسارع.',
      'أبلغ إدارة العقار كتابياً لبدء إخلاء هندسي.',
    ],
    en: [
      'Leave the unit and the affected area immediately without loading floors or stairs.',
      'Do not return to cracked rooms until a structural engineer has inspected them.',
      'Call civil defence on 911 if there is a fall, collapse, or rapidly widening crack.',
      'Notify building management in writing so a structural assessment can start.',
    ],
  },
  lock_failure: {
    ar: [
      'لا تحاول فتح الباب بالقوة إن كان هناك خطر كهرباء أو غاز في الداخل.',
      'اتصل بإدارة العقار أو فني أقفال موثوق، ولا تكسر الباب قبل تفويض المالك.',
      'اتصل على 911 إذا كان شخص محتجزاً أو كان هناك خطر داخل الوحدة.',
      'لا تترك الباب مفتوحاً دون مراقبة بعد الفتح.',
    ],
    en: [
      'Do not force the door if there is an electrical or gas hazard inside.',
      'Call building management or a trusted locksmith; do not break the door before the owner authorises it.',
      'Call 911 if a person is trapped or there is a hazard inside the unit.',
      'Do not leave the unit unsecured once it is open.',
    ],
  },
  no_heat: {
    ar: [
      'لا تستخدم أجهزة تدفئة غير معتمدة أو فحم أو شواية داخل الغرفة (خطر أول أكسيد الكربون).',
      'اتصل بإدارة العقار لطلب إصلاح فوري في الطقس البارد.',
      'اتصل على 911 إذا كان في المكان رضيع أو شخص مسن أو حالة طبية.',
    ],
    en: [
      'Do not use unapproved heaters, charcoal, or a barbecue indoors (carbon monoxide risk).',
      'Call building management to request an urgent repair in cold weather.',
      'Call 911 if an infant, an elderly person, or a medical case is in the unit.',
    ],
  },
};

const GENERIC_AR = [
  'ابتعد عن مصدر الخطر واتصل بالدفاع المدني على 911.',
  'لا تحاول إصلاح أي عطل خطير بنفسك.',
  'ابلغ إدارة العقار فوراً وقدّم عنوان الوحدة ورقمها.',
];

const GENERIC_EN = [
  'Keep away from the hazard and call civil defence on 911.',
  'Do not attempt to repair a serious fault yourself.',
  'Notify building management immediately with the unit address and number.',
];

/**
 * Render the immediate safety steps for a hazard key in the requested locale.
 * Unknown keys fall back to the generic 911 set — never to silence.
 */
export function safetyInstructions(signalKey: string, locale: SafetyLocale): string {
  const set = isKnownSignal(signalKey) ? SAFETY_INSTRUCTIONS[signalKey] : undefined;
  const steps = set === undefined ? (locale === 'ar' ? GENERIC_AR : GENERIC_EN) : set[locale];
  const footer = locale === 'ar' ? AR_FOOTER : EN_FOOTER;
  const header =
    locale === 'ar' ? 'إرشادات سلامة فورية:' : 'Immediate safety steps:';
  return [header, ...steps.map((s, i) => `${i + 1}. ${s}`), footer].join('\n');
}

function isKnownSignal(key: string): key is HazardSignalId {
  return Object.prototype.hasOwnProperty.call(SAFETY_INSTRUCTIONS, key);
}
