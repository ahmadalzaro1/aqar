/**
 * Aqar demo seed — one command: `pnpm db:seed`.
 *
 * Realistic bilingual Jordanian data (Amman: Jabal Al-Weibdeh + Abdoun) on top of
 * the real schema. Every invariant the database enforces is exercised for real:
 *   - rent charges come from the pure `generateMonthlyCharges` engine,
 *   - payments are allocated by `allocatePayment` (partials included),
 *   - owner distributions use `splitByShares` (shares sum to exactly 10000 bps),
 *   - bank lines are fingerprinted with `fingerprintBankLine` / `dedupeBankLines`,
 *   - ticket emergencies come from `emergencyPrecheck` (never hand-set),
 *   - journal entries are validated by `postJournal` and then by the DB trigger.
 *
 * IDEMPOTENT: every row gets a deterministic UUID derived from its natural key,
 * so re-running produces the same state and inserts nothing new.
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Allocation, Charge, LeaseMoneyTerms, OwnerShare, Payment } from '@aqar/contracts';
import {
  allocatePayment,
  dedupeBankLines,
  emergencyPrecheck,
  hazardSignalCategory,
  fingerprintBankLine,
  generateMonthlyCharges,
  mulDivFloor,
  postJournal,
  splitByShares,
} from '@aqar/core';
import { config as loadEnv } from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { createDb } from './client.js';
import { withOrganization } from './client.js';
import type { VendorTrade } from './schema/vendors.js';
import {
  auditEvents,
  bankImports,
  bankLines,
  buildings,
  charges,
  classifications,
  journalEntries,
  journalLines,
  leases,
  leaseTenants,
  managementFees,
  matchSuggestions,
  organizations,
  ownerApprovals,
  ownerStatements,
  owners,
  ownershipShares,
  paymentAllocations,
  payments,
  properties,
  tenants,
  tickets,
  units,
  users,
  vendors,
  distributions,
} from './schema/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/db/src -> repo root .env (dotenv never overrides an explicit DATABASE_URL).
loadEnv({ path: join(here, '..', '..', '..', '.env') });

export const SEED_ORG_SLUG = 'aqar-demo';
/** argon2id of the documented local password 'aqar-dev-admin-123'. Hash only, never the password. */
const DEV_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$XmOx/3jT0rme1+/FbZSvYA$MQV9UKD6RBT7NLTZkSLDjm8NaMXoqXIFqVlAz5pj2cI';

/** Deterministic, RFC-4122-shaped v5-style id: same natural key => same uuid, forever. */
function uid(key: string): string {
  const h = createHash('sha256').update(`aqar-demo:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** JOD (3 decimals) -> integer fils. Never floats in the database. */
function jod(value: number): number {
  return Math.round(value * 1000);
}

function monthKey(offsetFromNow: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetFromNow, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function firstOfMonth(period: string): string {
  return `${period}-01`;
}

function dayOfMonth(period: string, day: number): string {
  return `${period}-${String(day).padStart(2, '0')}`;
}

function isoDateDaysFromNow(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export type SeedCounts = {
  readonly users: number;
  readonly properties: number;
  readonly buildings: number;
  readonly units: number;
  readonly tenants: number;
  readonly leases: number;
  readonly charges: number;
  readonly payments: number;
  readonly allocations: number;
  readonly journalEntries: number;
  readonly vendors: number;
  readonly tickets: number;
  readonly emergencyTickets: number;
  readonly bankStatements: number;
  readonly bankLines: number;
  readonly owners: number;
  readonly ownershipShares: number;
  readonly auditEvents: number;
};

const ORG_ID = uid('org');
const PERIODS: readonly string[] = [-5, -4, -3, -2, -1, 0].map(monthKey);

type TenantSeed = { readonly en: string; readonly ar: string; readonly phone: string };

const TENANTS: readonly TenantSeed[] = [
  { en: 'Ahmad Mahmoud Al-Khatib', ar: 'أحمد محمود الخطيب', phone: '+962790110021' },
  { en: 'Samer Nabil Haddadin', ar: 'سامر نبيل حدادين', phone: '+962790110022' },
  { en: 'Mohammad Khaled Al-Abadi', ar: 'محمد خالد العبادي', phone: '+962790110023' },
  { en: 'Lina Omar Barakat', ar: 'لينا عمر بركات', phone: '+962790110024' },
  { en: 'Yousef Ibrahim Al-Rawashdeh', ar: 'يوسف إبراهيم الرواشدة', phone: '+962790110025' },
  { en: 'Rana Sami Qudah', ar: 'رنا سامي القضاة', phone: '+962790110026' },
  { en: 'Omar Ziad Al-Masri', ar: 'عمر زياد المصري', phone: '+962790110027' },
  { en: 'Dana Fawzi Shdeifat', ar: 'دانا فوزي شديفات', phone: '+962790110028' },
  { en: 'Tareq Hassan Al-Zoubi', ar: 'طارق حسن الزعبي', phone: '+962790110029' },
  { en: 'Maysa Jamal Al-Nsour', ar: 'ميساء جمال النسور', phone: '+962790110030' },
  { en: 'Khalil Adnan Tarawneh', ar: 'خليل عدنان الطراونة', phone: '+962790110031' },
  { en: 'Huda Mustafa Al-Khasawneh', ar: 'هدى مصطفى الخصاونة', phone: '+962790110032' },
  { en: 'Faisal Nasser Abu Sneineh', ar: 'فيصل ناصر أبو سنينة', phone: '+962790110033' },
  { en: 'Ghadeer Ali Al-Momani', ar: 'غدير علي المومني', phone: '+962790110034' },
  { en: 'Bashar Talal Al-Hourani', ar: 'بشار طلال الحوراني', phone: '+962790110035' },
  { en: 'Nour Emad Al-Dajani', ar: 'نور عماد الدجاني', phone: '+962790110036' },
  { en: 'Suleiman Ahmad Al-Jbour', ar: 'سليمان أحمد الجبور', phone: '+962790110037' },
  { en: 'Reem Hatem Al-Smadi', ar: 'ريم حاتم السمادي', phone: '+962790110038' },
];

const OWNERS: readonly { key: string; en: string; ar: string; phone: string }[] = [
  { key: 'heir-1', en: 'Husam Abdallah Al-Nabulsi', ar: 'حسام عبدالله النابلسي', phone: '+962795550101' },
  { key: 'heir-2', en: 'Rania Abdallah Al-Nabulsi', ar: 'رانيا عبدالله النابلسي', phone: '+962795550102' },
  { key: 'heir-3', en: 'Zaid Abdallah Al-Nabulsi', ar: 'زيد عبدالله النابلسي', phone: '+962795550103' },
  { key: 'heir-4', en: 'Dima Abdallah Al-Nabulsi', ar: 'ديمة عبدالله النابلسي', phone: '+962795550104' },
  { key: 'partner-1', en: 'Abdoun Real Estate Partners LLC', ar: 'شركة شركاء عبدون العقارية', phone: '+962655550201' },
  { key: 'partner-2', en: 'Nadia Kamal Al-Tal', ar: 'نادية كمال التل', phone: '+962795550202' },
  { key: 'waqf-1', en: 'Al-Weibdeh Family Trust', ar: 'صندوق عائلة الويبدية', phone: '+962655550301' },
];

const VENDORS: readonly {
  key: string;
  en: string;
  ar: string;
  trades: readonly VendorTrade[];
  expiryDays: number;
  rating: string;
}[] = [
  { key: 'plumbing', en: 'Al-Weibdeh Plumbing Works', ar: 'ورشة سباكة الويبدية', trades: ['plumbing'], expiryDays: 18, rating: '4.6' },
  { key: 'electrical', en: 'Amman Electric Contractors', ar: 'مقاولو الكهرباء - عمان', trades: ['electrical'], expiryDays: 240, rating: '4.2' },
  { key: 'elevator', en: 'Jordan Elevator Maintenance Co.', ar: 'الشركة الأردنية لصيانة المصاعد', trades: ['elevator', 'generator'], expiryDays: 120, rating: '4.8' },
  { key: 'hvac', en: 'Cool Air HVAC Services', ar: 'كوول إير للتكييف والتبريد', trades: ['hvac', 'appliance'], expiryDays: 400, rating: '3.9' },
];

type TicketSeed = {
  readonly subject: string;
  readonly body: string;
  readonly locale: 'ar' | 'en';
  readonly category: string;
  readonly severity: 'emergency' | 'high' | 'medium' | 'low' | 'cosmetic';
  readonly status: 'new' | 'triaged' | 'awaiting_tenant' | 'approved' | 'dispatched' | 'in_progress' | 'completed' | 'closed';
  readonly daysAgo: number;
};

const CURRENT_TICKETS: readonly TicketSeed[] = [
  // --- 3 emergencies (flagged by the deterministic precheck, never hand-set) ---
  { subject: 'ريحة غاز قوية بالمطبخ', body: 'ريحة غاز قوية بالمطبخ من ساعة ما رجعت من الشغل، سكرت الغاز والريحة لسا موجودة. بدي حد يجي بسرعه.', locale: 'ar', category: 'gas', severity: 'emergency', status: 'dispatched', daysAgo: 0 },
  { subject: 'حريق صغير في غرفة النوم', body: 'حريق صغير صار قرب المقبس والشرر يطلع من الغرفة، طفينا المفتاح الرئيسي. البيت فيه أولاد صغار بدنا مساعدة فورية.', locale: 'ar', category: 'fire', severity: 'emergency', status: 'in_progress', daysAgo: 0 },
  { subject: 'مجاري طالعة بالحمام', body: 'تسرب مياه المجاري في الحمام الرئيسي والمية عم تغرق كل الشقة، والريحة كتير قوية.', locale: 'ar', category: 'sewage', severity: 'emergency', status: 'triaged', daysAgo: 1 },
  // --- 5 habitability (high) ---
  { subject: 'انقطاع الماء عن الشقة', body: 'ضغط المية نازل كتير بالشقة من يومين والجيران عندهم ضغط عادي. الحنفية تفتح بشعرة مية بس.', locale: 'ar', category: 'water', severity: 'high', status: 'dispatched', daysAgo: 2 },
  { subject: 'عفن ورطوبة في الجدار الخارجي', body: 'الرطوبة طالعة داخل غرفة النوم والعفن كبر، عندنا طفل عنده حساسية صدرية. الموضوع صحي.', locale: 'ar', category: 'structural', severity: 'high', status: 'triaged', daysAgo: 3 },
  { subject: 'التدفئة لا تعمل والبيت بارد', body: 'المدفأة الكهربائية ما بتشتغل والبيت برد كتير خاصة بالليل. بدنا صيانة أو مدفأة بديلة.', locale: 'ar', category: 'hvac', severity: 'high', status: 'approved', daysAgo: 4 },
  { subject: 'صراصير في المطبخ', body: 'في صراصير بالفوارع وبالمطبخ بشكل كبير، بدنا مكافحة حشرات للشقة كلها.', locale: 'ar', category: 'pest', severity: 'high', status: 'dispatched', daysAgo: 5 },
  { subject: 'شباك غرفة الأولاد مكسور', body: 'الشباك الزجاجي بغرفة الأولاد مكسور والزجاج مفتوح على الشارع، خطر عليهم.', locale: 'ar', category: 'structural', severity: 'high', status: 'in_progress', daysAgo: 6 },
  // --- mixed routine ---
  { subject: 'Kitchen faucet dripping', body: 'The kitchen faucet has been dripping for a week and the cabinet under the sink is damp.', locale: 'en', category: 'plumbing', severity: 'medium', status: 'triaged', daysAgo: 2 },
  { subject: 'مفتاح الباب المصعد عاطل', body: 'مفتاح باب المصعد ما بيقفل، الباب بيضل مفتوح على الطابق.', locale: 'ar', category: 'lock', severity: 'medium', status: 'dispatched', daysAgo: 3 },
  { subject: 'لمبة الدرج محروقة', body: 'لمبة الدرج بين الطابق الثاني والثالث محروقة من أسبوع.', locale: 'ar', category: 'common_area', severity: 'low', status: 'completed', daysAgo: 8 },
  { subject: 'المولدة تطلع صوت عالي', body: 'المولدة بتشتغل كل يوم الساعة ٨ المسا وصوتها عالي كتير. في أطفال بتنام بهذا الوقت.', locale: 'ar', category: 'generator', severity: 'medium', status: 'in_progress', daysAgo: 4 },
  { subject: 'المصعد يتوقف بين الطوابق', body: 'المصعد وقف مرة بين الثاني والثالث وفتح الباب لحاله بعد دقيقة.', locale: 'ar', category: 'elevator', severity: 'medium', status: 'triaged', daysAgo: 7 },
  { subject: 'عطل في الغسالة الكهربائية', body: 'غسالة الشقة ما بتعصر، المية بتضل جوا الحلة.', locale: 'ar', category: 'appliance', severity: 'medium', status: 'awaiting_tenant', daysAgo: 9 },
  { subject: 'تسريب ماء تحت المغسلة', body: 'المغسلة بتسرّب مية على البلاط، بدنا سباك.', locale: 'ar', category: 'plumbing', severity: 'medium', status: 'completed', daysAgo: 11 },
  { subject: 'Broken bedroom door handle', body: 'The bedroom door handle snapped off; the door cannot be closed from inside.', locale: 'en', category: 'lock', severity: 'low', status: 'completed', daysAgo: 13 },
  { subject: 'صوت تكييف عالي في الصالة', body: 'المكيف بالصالة بيعمل صوت طقطقة عالي لما يشتغل.', locale: 'ar', category: 'hvac', severity: 'low', status: 'triaged', daysAgo: 10 },
  { subject: 'مفتاح الشقة ضاع', body: 'ضاع مني مفتاح الشقة، بدي مفتاح جديد على حسابي.', locale: 'ar', category: 'lock', severity: 'medium', status: 'completed', daysAgo: 15 },
  { subject: 'Water pressure very low upstairs', body: 'The shower upstairs has almost no pressure in the morning.', locale: 'en', category: 'water', severity: 'medium', status: 'triaged', daysAgo: 6 },
  { subject: 'رشح من سقف الحمام', body: 'في رشح من سقف الحمام من الشقة اللي فوقنا.', locale: 'ar', category: 'water', severity: 'medium', status: 'dispatched', daysAgo: 5 },
  { subject: 'إنارة الساحة الخارجية مطفية', body: 'إنارة الساحة الخارجية مطفية من ثلاثة أيام، البناية معتمة بالليل.', locale: 'ar', category: 'common_area', severity: 'medium', status: 'in_progress', daysAgo: 4 },
  { subject: 'كرسي الحمام مهتز', body: 'قاعدة كرسي الحمام مهتزة وبتتحرك، بدها تثبيت.', locale: 'ar', category: 'plumbing', severity: 'low', status: 'completed', daysAgo: 18 },
  { subject: 'نمل في المطبخ', body: 'نمل صغير طالع بالمطبخ قرب الحوض.', locale: 'ar', category: 'pest', severity: 'low', status: 'closed', daysAgo: 20 },
  { subject: 'Scratched lobby door glass', body: 'The lobby glass door has deep scratches from the cleaning crew.', locale: 'en', category: 'common_area', severity: 'cosmetic', status: 'closed', daysAgo: 22 },
  { subject: 'جرس الباب لا يعمل', body: 'جرس الباب ما بيعمل صوت، بدنا تصليح.', locale: 'ar', category: 'electrical', severity: 'low', status: 'new', daysAgo: 1 },
  { subject: 'خزان الماء يحتاج تنظيف', body: 'خزان الماء بالسطح ما تنظف من سنة، البيئة غير نظيفة.', locale: 'ar', category: 'water', severity: 'medium', status: 'triaged', daysAgo: 8 },
  { subject: 'باب البناية ما بيسكر', body: 'باب البناية الرئيسي ما بيسكر منيح، أي حد بيقدر يدخل.', locale: 'ar', category: 'lock', severity: 'medium', status: 'dispatched', daysAgo: 2 },
  { subject: 'تسريب من أنبوب المولدة', body: 'في تسريب زيت من أنبوب المولدة في القبو.', locale: 'ar', category: 'generator', severity: 'medium', status: 'triaged', daysAgo: 3 },
  { subject: 'Light flickering in hallway', body: 'The hallway light on the fourth floor flickers constantly at night.', locale: 'en', category: 'electrical', severity: 'low', status: 'completed', daysAgo: 16 },
  { subject: 'مكيف غرفة النوم ما بيبرد', body: 'المكيف بيشتغل بس ما بيبرد، بدنا فحص فريون وتنظيف فلاتر.', locale: 'ar', category: 'hvac', severity: 'medium', status: 'approved', daysAgo: 7 },
];

const CLOSED_PAST_TICKETS: readonly TicketSeed[] = [
  { subject: 'تسريب غاز من الأنبوب الرئيسي', body: 'تم استبدال أنبوب الخدمة الرئيسي بالبناية خلال الصيانة الدورية.', locale: 'ar', category: 'gas', severity: 'emergency', status: 'closed', daysAgo: 210 },
  { subject: 'حريق بمطبخ الشقة ٤', body: 'تم تغيير القطع الكهربائية بمطبخ الشقة بعد ارتفاع حرارة المقبس.', locale: 'ar', category: 'fire', severity: 'emergency', status: 'closed', daysAgo: 300 },
  { subject: 'المصعد توقف والأطفال داخله', body: 'تم تحديث لوحة تحكم المصعد وفحص الكابلات.', locale: 'ar', category: 'elevator', severity: 'emergency', status: 'closed', daysAgo: 160 },
  { subject: 'انفجار أنبوب مياه رئيسي بالقبو', body: 'تم استبدال مضخة القبو بعد توقفها خلال الصيانة الدورية.', locale: 'ar', category: 'water', severity: 'high', status: 'closed', daysAgo: 190 },
  { subject: 'تسرب مجاري في الشقة ٢٠١', body: 'تم تنظيف شبكة الصرف بالشقة وإعادة تركيب الغطاء.', locale: 'ar', category: 'sewage', severity: 'high', status: 'closed', daysAgo: 240 },
  { subject: 'عفن واسع في الحمام', body: 'تمت إعادة دهان الحمام بعد معالجة الرطوبة.', locale: 'ar', category: 'structural', severity: 'high', status: 'closed', daysAgo: 150 },
  { subject: 'انقطاع الماء ثلاثة أيام', body: 'تم تغيير مضخة الماء الرئيسية للبناية بعد توقفها.', locale: 'ar', category: 'water', severity: 'high', status: 'closed', daysAgo: 260 },
  { subject: 'صراصير في مطبخ الشقة ٥٠٢', body: 'تمت مكافحة الحشرات للشقة والبناية.', locale: 'ar', category: 'pest', severity: 'medium', status: 'closed', daysAgo: 130 },
  { subject: 'مكيف الصالة لا يبرد', body: 'تم تعبئة الفريون وتنظيف الفلتر.', locale: 'ar', category: 'hvac', severity: 'medium', status: 'closed', daysAgo: 100 },
  { subject: 'سخان الماء لا يعمل', body: 'تم تغيير السخان الكهربائي في الشقة ٣٠٢.', locale: 'ar', category: 'appliance', severity: 'medium', status: 'closed', daysAgo: 170 },
  { subject: 'كسر زجاج مدخل البناية', body: 'تم تغيير الزجاج المكسور لمدخل البناية.', locale: 'ar', category: 'common_area', severity: 'low', status: 'closed', daysAgo: 120 },
  { subject: 'Repeated lock jams on unit 401', body: 'Replaced a worn door cylinder in unit 401.', locale: 'en', category: 'lock', severity: 'low', status: 'closed', daysAgo: 140 },
];

export async function runSeed(url?: string): Promise<SeedCounts> {
  const { client, db } = createDb(url);
  try {
    const orgValues = {
      id: ORG_ID,
      name: 'Aqar Demo',
      nameAr: 'عقار التجريبي',
      slug: SEED_ORG_SLUG,
      timezone: 'Asia/Amman',
      currency: 'JOD',
    };
    await db.insert(organizations).values(orgValues).onConflictDoNothing();

    await withOrganization(db, ORG_ID, async (tx) => {
      // ---------------------------------------------------------------- users
      const userRows = [
        { key: 'admin', email: 'admin@aqar.example', role: 'owner_admin' as const, en: 'Dina Al-Fayez', ar: 'دينا الفايز' },
        { key: 'manager', email: 'manager@aqar.example', role: 'property_manager' as const, en: 'Basel Odeh', ar: 'باسل عودة' },
        { key: 'accountant', email: 'accountant@aqar.example', role: 'accountant' as const, en: 'Hala Qasem', ar: 'هالة قاسم' },
        { key: 'coordinator', email: 'coordinator@aqar.example', role: 'maintenance_coordinator' as const, en: 'Munther Sabbagh', ar: 'منذر صباغ' },
      ];
      await tx
        .insert(users)
        .values(
          userRows.map((u) => ({
            id: uid(`user:${u.key}`),
            organizationId: ORG_ID,
            email: u.email,
            passwordHash: DEV_PASSWORD_HASH,
            role: u.role,
            nameEn: u.en,
            nameAr: u.ar,
            totpSecret: null,
            isActive: true,
          })),
        )
        .onConflictDoNothing();

      // ------------------------------------------------------------ properties
      const propertyRows = [
        {
          key: 'weibdeh',
          id: uid('property:weibdeh'),
          name: 'Al-Weibdeh Heritage Building',
          nameAr: 'بناية الويبدية التراثية',
          district: 'Jabal Al-Weibdeh',
          buildingName: 'بناية أبو جابر',
          street: 'شارع الرينبو',
          city: 'Amman',
          lat: 31.9512,
          lng: 35.9239,
        },
        {
          key: 'abdoun',
          id: uid('property:abdoun'),
          name: 'Abdoun Gardens Residence',
          nameAr: 'سكن حدائق عبدون',
          district: 'Abdoun',
          buildingName: 'عمارة الياسمين',
          street: 'شارع الأمير هاشم',
          city: 'Amman',
          lat: 31.9441,
          lng: 35.8792,
        },
      ];
      await tx
        .insert(properties)
        .values(
          propertyRows.map((p) => ({
            id: p.id,
            organizationId: ORG_ID,
            name: p.name,
            nameAr: p.nameAr,
            district: p.district,
            buildingName: p.buildingName,
            street: p.street,
            city: p.city,
            lat: p.lat,
            lng: p.lng,
            notes: null,
          })),
        )
        .onConflictDoNothing();

      const buildingRows = propertyRows.map((p) => ({
        id: uid(`building:${p.key}`),
        organizationId: ORG_ID,
        propertyId: p.id,
        name: `${p.name} — Main Building`,
        nameAr: `${p.nameAr} — البناية الرئيسية`,
        floors: 4,
        yearBuilt: p.key === 'weibdeh' ? 1968 : 2014,
        elevator: true,
        notes: null,
      }));
      await tx.insert(buildings).values(buildingRows).onConflictDoNothing();

      // ----------------------------------------------------------------- units
      type UnitRow = {
        id: string;
        key: string;
        propertyKey: string;
        propertyId: string;
        buildingId: string;
        unitNumber: string;
        floor: string;
        bedrooms: number;
        bathrooms: number;
        areaSqm: string;
        marketRentFils: number;
        status: 'vacant' | 'occupied' | 'turnover' | 'unavailable';
        notes: string | null;
      };
      const unitRows: UnitRow[] = [];
      for (const p of propertyRows) {
        const buildingId = uid(`building:${p.key}`);
        for (let floor = 1; floor <= 4; floor += 1) {
          for (let n = 1; n <= 3; n += 1) {
            const index = unitRows.length;
            const unitNumber = `${floor}0${n}`;
            const occupied = index < 18;
            const status: UnitRow['status'] = occupied
              ? 'occupied'
              : index === 18
                ? 'vacant'
                : index === 19
                  ? 'vacant'
                  : index === 20
                    ? 'vacant'
                    : index === 21
                      ? 'vacant'
                      : index === 22
                        ? 'turnover'
                        : 'unavailable';
            unitRows.push({
              id: uid(`unit:${p.key}:${unitNumber}`),
              key: `${p.key}:${unitNumber}`,
              propertyKey: p.key,
              propertyId: p.id,
              buildingId,
              unitNumber,
              floor: String(floor),
              bedrooms: n === 1 ? 1 : n === 2 ? 2 : 3,
              bathrooms: n === 1 ? 1 : 2,
              areaSqm: String(68 + n * 22 + floor * 3),
              marketRentFils: jod(p.key === 'abdoun' ? 520 + floor * 25 : 340 + floor * 15),
              status,
              notes: status === 'unavailable' ? 'مغلقة للترميم الشامل — لا تُعرض للإيجار' : null,
            });
          }
        }
      }
      await tx
        .insert(units)
        .values(
          unitRows.map((u) => ({
            id: u.id,
            organizationId: ORG_ID,
            propertyId: u.propertyId,
            buildingId: u.buildingId,
            unitNumber: u.unitNumber,
            floor: u.floor,
            bedrooms: u.bedrooms,
            bathrooms: u.bathrooms,
            areaSqm: u.areaSqm,
            marketRentFils: u.marketRentFils,
            status: u.status,
            notes: u.notes,
          })),
        )
        .onConflictDoNothing();

      // --------------------------------------------------------------- tenants
      const tenantRows = TENANTS.map((t, i) => ({
        id: uid(`tenant:${i}`),
        organizationId: ORG_ID,
        fullNameEn: t.en,
        fullNameAr: t.ar,
        phone: t.phone,
        email: `${t.en.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
        nationalIdHash: null,
        userId: null,
        notes: null,
      }));
      await tx.insert(tenants).values(tenantRows).onConflictDoNothing();

      // ---------------------------------------------------------------- owners
      await tx
        .insert(owners)
        .values(
          OWNERS.map((o) => ({
            id: uid(`owner:${o.key}`),
            organizationId: ORG_ID,
            fullNameEn: o.en,
            fullNameAr: o.ar,
            phone: o.phone,
            email: `${o.key}@owners.example.com`,
            nationalIdHash: null,
            bankIban: `JO94CBJO0010000000000131000${o.key.length}`,
            userId: null,
            notes: null,
          })),
        )
        .onConflictDoNothing();

      // Ownership shares: property 1 = 4 heirs @ 2500 bps; property 2 = 3 owners (3000+2500+4500).
      const weibdehShares: OwnerShare[] = [
        { ownerId: uid('owner:heir-1'), shareBps: 2500 },
        { ownerId: uid('owner:heir-2'), shareBps: 2500 },
        { ownerId: uid('owner:heir-3'), shareBps: 2500 },
        { ownerId: uid('owner:heir-4'), shareBps: 2500 },
      ];
      const abdounShares: OwnerShare[] = [
        { ownerId: uid('owner:partner-1'), shareBps: 3000 },
        { ownerId: uid('owner:partner-2'), shareBps: 2500 },
        { ownerId: uid('owner:waqf-1'), shareBps: 4500 },
      ];
      const shareRows = [
        ...weibdehShares.map((s) => ({
          id: uid(`share:weibdeh:${s.ownerId}`),
          organizationId: ORG_ID,
          ownerId: s.ownerId,
          propertyId: uid('property:weibdeh'),
          shareBps: s.shareBps,
          effectiveFrom: '2024-01-01',
        })),
        ...abdounShares.map((s) => ({
          id: uid(`share:abdoun:${s.ownerId}`),
          organizationId: ORG_ID,
          ownerId: s.ownerId,
          propertyId: uid('property:abdoun'),
          shareBps: s.shareBps,
          effectiveFrom: '2024-01-01',
        })),
      ];
      await tx.insert(ownershipShares).values(shareRows).onConflictDoNothing();

      // ---------------------------------------------------------------- leases
      const occupiedUnits = unitRows.filter((u) => u.status === 'occupied');
      type LeaseRow = {
        id: string;
        index: number;
        unit: UnitRow;
        tenantId: string;
        rentFils: number;
        depositFils: number;
        dueDay: number;
        startDate: string;
        endDate: string;
      };
      const leaseRows: LeaseRow[] = occupiedUnits.map((unit, i) => {
        const tenant = tenantRows[i % tenantRows.length];
        const rentFils = unit.marketRentFils + (i % 4) * jod(15);
        return {
          id: uid(`lease:${unit.key}`),
          index: i,
          unit,
          tenantId: tenant === undefined ? uid('tenant:0') : tenant.id,
          rentFils,
          depositFils: rentFils,
          dueDay: 1 + (i % 5),
          startDate: i % 6 === 5 ? `${PERIODS[3] ?? '2026-01'}-01` : '2024-06-01',
          endDate: i % 9 === 4 ? `${PERIODS[5] ?? '2026-11'}-28` : '2028-05-31',
        };
      });
      const lateFeeRule = {
        kind: 'percent' as const,
        basisPoints: 500,
        graceDays: 7,
        capFils: jod(30),
      };
      await tx
        .insert(leases)
        .values(
          leaseRows.map((l) => ({
            id: l.id,
            organizationId: ORG_ID,
            propertyId: l.unit.propertyId,
            unitId: l.unit.id,
            status: 'active' as const,
            startDate: l.startDate,
            endDate: l.endDate,
            rentFils: l.rentFils,
            depositFils: l.depositFils,
            dueDay: l.dueDay,
            lateFeeRule,
            escalationRule: { kind: 'none' as const },
            signedAt: new Date(`${l.startDate}T09:00:00Z`),
            terminatedAt: null,
            notes: null,
          })),
        )
        .onConflictDoNothing();
      await tx
        .insert(leaseTenants)
        .values(
          leaseRows.map((l) => ({
            id: uid(`lease-tenant:${l.id}`),
            organizationId: ORG_ID,
            leaseId: l.id,
            tenantId: l.tenantId,
            isPrimary: true,
            shareBps: 10000,
            signedAt: new Date(`${l.startDate}T09:00:00Z`),
          })),
        )
        .onConflictDoNothing();

      // --------------------------------------------------------------- charges
      const leaseTerms: LeaseMoneyTerms[] = leaseRows.map((l) => ({
        leaseId: l.id,
        rentFils: l.rentFils,
        depositFils: l.depositFils,
        dueDay: l.dueDay,
        startISO: l.startDate,
        endISO: l.endDate,
        lateFeeRule,
        escalationRule: { kind: 'none' },
        status: 'active',
      }));

      const chargeContracts: Charge[] = [];
      const chargeIdByCoreId = new Map<string, string>();
      for (const period of PERIODS) {
        const generated = generateMonthlyCharges(leaseTerms, period, chargeContracts);
        for (const charge of generated) {
          chargeContracts.push(charge);
          chargeIdByCoreId.set(charge.id, uid(`charge:${charge.id}`));
        }
      }
      await tx
        .insert(charges)
        .values(
          chargeContracts.map((c) => ({
            id: chargeIdByCoreId.get(c.id) ?? uid(`charge:${c.id}`),
            organizationId: ORG_ID,
            leaseId: c.leaseId,
            period: c.period,
            kind: 'rent' as const,
            amountFils: c.amountFils,
            dueDate: c.dueDateISO,
            proratedDays: c.proratedDays,
            notes: null,
          })),
        )
        .onConflictDoNothing();

      // -------------------------------------------------------------- payments
      const chargesByLease = new Map<string, Charge[]>();
      for (const charge of chargeContracts) {
        const list = chargesByLease.get(charge.leaseId) ?? [];
        list.push(charge);
        chargesByLease.set(charge.leaseId, list);
      }

      const paymentRows: {
        id: string;
        payerId: string;
        amountFils: number;
        receivedDate: string;
        method: 'cash' | 'cliq' | 'bank_transfer' | 'cheque';
        referencePeriod: string | null;
        referenceText: string | null;
        chequeStatus: 'received' | 'deposited' | 'bounced' | null;
        notes: string | null;
      }[] = [];
      const allocationRows: {
        id: string;
        paymentId: string;
        chargeId: string;
        amountFils: number;
        allocatedAt: Date;
      }[] = [];
      const contractAllocations: Allocation[] = [];
      const receiptTotals = new Map<string, number>();
      let bouncedCheque: { paymentId: string; amountFils: number; period: string } | null = null;

      const addReceipt = (period: string, amountFils: number): void => {
        receiptTotals.set(period, (receiptTotals.get(period) ?? 0) + amountFils);
      };

      for (const lease of leaseRows) {
        const leaseCharges = chargesByLease.get(lease.id) ?? [];
        for (let j = 0; j < PERIODS.length; j += 1) {
          const period = PERIODS[j];
          if (period === undefined) continue;
          const charge = leaseCharges.find((c) => c.period === period);
          if (charge === undefined) continue;

          // One delinquency gap per 7 leases: no payment in the second period.
          if (lease.index % 7 === 3 && j === 1) continue;
          // Current month is only partly collected.
          if (j === PERIODS.length - 1 && lease.index % 3 !== 0) continue;

          const partial = lease.index % 5 === 0 && (j === 1 || j === 3);
          const isBounced = lease.index === 2 && j === 2;
          const isCash = lease.index === 4 && j === 4;
          const amountFils = partial ? Math.max(1, charge.amountFils - jod(25)) : charge.amountFils;
          const method: 'cash' | 'cliq' | 'bank_transfer' | 'cheque' = isBounced
            ? 'cheque'
            : isCash
              ? 'cash'
              : lease.index % 4 === 0
                ? 'cliq'
                : 'bank_transfer';
          const paymentId = uid(`payment:${lease.id}:${period}`);
          const receivedDate =
            method === 'cheque' ? dayOfMonth(period, Math.min(6, 28)) : dayOfMonth(period, Math.min(3, 28));

          paymentRows.push({
            id: paymentId,
            payerId: lease.tenantId,
            amountFils,
            receivedDate,
            method,
            referencePeriod: period,
            referenceText:
              method === 'cheque'
                ? `CHQ-${period.replace('-', '')}-0042`
                : method === 'cash'
                  ? 'إيصال نقدي يدوي'
                  : `TRF ${lease.unit.unitNumber} ${period}`,
            chequeStatus: method === 'cheque' ? 'bounced' : null,
            notes: isBounced ? 'شيك مرتجع — تم عكس التخصيص وإعادة فتح المستحق' : null,
          });

          const paymentContract: Payment = {
            id: paymentId,
            payerId: lease.tenantId,
            amountFils,
            receivedDateISO: receivedDate,
            method,
            referencePeriod: period,
            referenceText: null,
            chequeStatus: method === 'cheque' ? 'bounced' : null,
          };

          if (isBounced) {
            // Compute the allocation the cheque *would* have made, then reverse it:
            // the charge must end up exactly as outstanding as it was before.
            const tentative = allocatePayment(paymentContract, leaseCharges, contractAllocations);
            const reversedTotal = tentative.reduce((sum, a) => sum + a.amountFils, 0);
            bouncedCheque = { paymentId, amountFils: reversedTotal, period };
            continue;
          }

          const allocations = allocatePayment(paymentContract, leaseCharges, contractAllocations);
          for (const allocation of allocations) {
            const chargeUuid = chargeIdByCoreId.get(allocation.chargeId);
            if (chargeUuid === undefined) continue;
            contractAllocations.push({
              paymentId: allocation.paymentId,
              chargeId: allocation.chargeId,
              amountFils: allocation.amountFils,
            });
            allocationRows.push({
              id: uid(`allocation:${paymentId}:${chargeUuid}`),
              paymentId,
              chargeId: chargeUuid,
              amountFils: allocation.amountFils,
              allocatedAt: new Date(`${receivedDate}T11:00:00Z`),
            });
          }
          addReceipt(period, amountFils);
        }
      }

      await tx
        .insert(payments)
        .values(
          paymentRows.map((p) => ({
            id: p.id,
            organizationId: ORG_ID,
            payerId: p.payerId,
            amountFils: p.amountFils,
            receivedDate: p.receivedDate,
            method: p.method,
            referencePeriod: p.referencePeriod,
            referenceText: p.referenceText,
            chequeStatus: p.chequeStatus,
            notes: p.notes,
          })),
        )
        .onConflictDoNothing();
      await tx
        .insert(paymentAllocations)
        .values(
          allocationRows.map((a) => ({
            id: a.id,
            organizationId: ORG_ID,
            paymentId: a.paymentId,
            chargeId: a.chargeId,
            amountFils: a.amountFils,
            allocatedAt: a.allocatedAt,
          })),
        )
        .onConflictDoNothing();

      // ---------------------------------------------------------- journal entries
      const existingEntries = new Set(
        (
          await tx
            .select({ id: journalEntries.id })
            .from(journalEntries)
            .where(eq(journalEntries.organizationId, ORG_ID))
        ).map((r) => r.id),
      );

      type EntryPlan = { id: string; period: string; memo: string; sourceType: string; sourceId: string; lines: readonly { accountCode: 'tenant_ar' | 'trust_cash' | 'income' | 'cheques_in_transit'; debitFils: number; creditFils: number }[] };
      const entryPlans: EntryPlan[] = [];

      for (const period of PERIODS) {
        const periodCharges = chargeContracts.filter((c) => c.period === period);
        const rentTotal = periodCharges.reduce((sum, c) => sum + c.amountFils, 0);
        if (rentTotal > 0) {
          entryPlans.push({
            id: uid(`journal:rent:${period}`),
            period,
            memo: `إثبات إيجارات ${period} — ${periodCharges.length} عقد`,
            sourceType: 'rent_charge',
            sourceId: `rent:${period}`,
            lines: [
              { accountCode: 'tenant_ar', debitFils: rentTotal, creditFils: 0 },
              { accountCode: 'income', debitFils: 0, creditFils: rentTotal },
            ],
          });
        }
        const receipts = receiptTotals.get(period) ?? 0;
        if (receipts > 0) {
          entryPlans.push({
            id: uid(`journal:receipts:${period}`),
            period,
            memo: `تحصيلات ${period} — حساب الأمانة`,
            sourceType: 'payment_receipt',
            sourceId: `receipts:${period}`,
            lines: [
              { accountCode: 'trust_cash', debitFils: receipts, creditFils: 0 },
              { accountCode: 'tenant_ar', debitFils: 0, creditFils: receipts },
            ],
          });
        }
      }
      if (bouncedCheque !== null && bouncedCheque.amountFils > 0) {
        entryPlans.push({
          id: uid(`journal:cheque:${bouncedCheque.paymentId}`),
          period: bouncedCheque.period,
          memo: 'إيداع شيك إيجار — شيكات برسم التحصيل',
          sourceType: 'cheque_deposit',
          sourceId: bouncedCheque.paymentId,
          lines: [
            { accountCode: 'cheques_in_transit', debitFils: bouncedCheque.amountFils, creditFils: 0 },
            { accountCode: 'tenant_ar', debitFils: 0, creditFils: bouncedCheque.amountFils },
          ],
        });
        entryPlans.push({
          id: uid(`journal:cheque-bounce:${bouncedCheque.paymentId}`),
          period: bouncedCheque.period,
          memo: 'شيك مرتجع — عكس القيد وإعادة فتح المستحق',
          sourceType: 'cheque_bounce',
          sourceId: `${bouncedCheque.paymentId}:bounce`,
          lines: [
            { accountCode: 'tenant_ar', debitFils: bouncedCheque.amountFils, creditFils: 0 },
            { accountCode: 'cheques_in_transit', debitFils: 0, creditFils: bouncedCheque.amountFils },
          ],
        });
      }

      // postJournal validates the double-entry shape before anything touches the DB.
      const entryLines: (typeof journalLines.$inferInsert)[] = [];
      for (const plan of entryPlans) {
        const validated = postJournal(
          plan.lines.map((line) => ({
            accountCode: line.accountCode,
            debitFils: line.debitFils,
            creditFils: line.creditFils,
            memo: plan.memo,
            sourceType: plan.sourceType,
            sourceId: plan.sourceId,
            period: plan.period,
          })),
          [],
        );
        if (existingEntries.has(plan.id)) continue;
        for (const line of validated) {
          entryLines.push({
            id: uid(`journal-line:${plan.id}:${line.accountCode}:${line.debitFils}:${line.creditFils}`),
            organizationId: ORG_ID,
            entryId: plan.id,
            accountCode: line.accountCode,
            debitFils: line.debitFils,
            creditFils: line.creditFils,
            memo: line.memo,
            sourceType: line.sourceType,
            sourceId: line.sourceId,
            period: line.period,
          });
        }
      }

      // Entries are inserted unposted, lines added while mutable, then posted
      // (the DB trigger re-checks the balance at posted=true).
      const newEntryIds = entryPlans.filter((p) => !existingEntries.has(p.id)).map((p) => p.id);
      await tx
        .insert(journalEntries)
        .values(
          entryPlans.map((p) => ({
            id: p.id,
            organizationId: ORG_ID,
            entryDate: firstOfMonth(p.period),
            period: p.period,
            memo: p.memo,
            posted: false,
            postedAt: null,
            sourceType: p.sourceType,
            sourceId: p.sourceId,
          })),
        )
        .onConflictDoNothing();
      if (entryLines.length > 0) {
        await tx.insert(journalLines).values(entryLines).onConflictDoNothing();
      }
      for (const entryId of newEntryIds) {
        await tx
          .update(journalEntries)
          .set({ posted: true, postedAt: new Date() })
          .where(eq(journalEntries.id, entryId));
      }

      // --------------------------------------------------------- owner reports
      const closedPeriod = PERIODS[PERIODS.length - 2] ?? PERIODS[0] ?? '2026-01';
      for (const property of propertyRows) {
        const propertyLeases = leaseRows.filter((l) => l.unit.propertyKey === property.key);
        const propertyRent = propertyLeases.reduce((sum, l) => {
          const charge = chargeContracts.find((c) => c.leaseId === l.id && c.period === closedPeriod);
          return sum + (charge?.amountFils ?? 0);
        }, 0);
        const expenses = mulDivFloor(propertyRent, 900, 10000);
        const fee = mulDivFloor(propertyRent, 800, 10000);
        await tx
          .insert(ownerStatements)
          .values({
            id: uid(`owner-statement:${property.key}:${closedPeriod}`),
            organizationId: ORG_ID,
            propertyId: property.id,
            period: closedPeriod,
            grossRentFils: propertyRent,
            expensesFils: expenses,
            managementFeeFils: fee,
            netFils: Math.max(0, propertyRent - expenses - fee),
            issuedAt: new Date(),
            documentKey: null,
          })
          .onConflictDoNothing();
        await tx
          .insert(managementFees)
          .values({
            id: uid(`management-fee:${property.key}:${closedPeriod}`),
            organizationId: ORG_ID,
            propertyId: property.id,
            period: closedPeriod,
            basisBps: 800,
            baseFils: propertyRent,
            feeFils: fee,
          })
          .onConflictDoNothing();

        const distributable = Math.max(0, propertyRent - expenses - fee);
        const shares = property.key === 'weibdeh' ? weibdehShares : abdounShares;
        const split = splitByShares(distributable, shares);
        for (const share of shares) {
          const amount = split[share.ownerId] ?? 0;
          await tx
            .insert(distributions)
            .values({
              id: uid(`distribution:${property.key}:${closedPeriod}:${share.ownerId}`),
              organizationId: ORG_ID,
              ownerId: share.ownerId,
              propertyId: property.id,
              period: closedPeriod,
              amountFils: amount,
              status: 'pending_approval',
              approvedAt: null,
              paidAt: null,
            })
            .onConflictDoNothing();
        }

        // 3-of-4 heir approval for the Weibdeh distribution.
        if (property.key === 'weibdeh') {
          const approvalRows = weibdehShares.map((share, i) => ({
            id: uid(`owner-approval:${closedPeriod}:${share.ownerId}`),
            organizationId: ORG_ID,
            distributionId: uid(`distribution:weibdeh:${closedPeriod}:${share.ownerId}`),
            spendId: null,
            spendKind: 'opex' as const,
            ownerId: share.ownerId,
            vote: (i === 3 ? 'no' : 'yes') as 'yes' | 'no',
            comment: i === 3 ? 'أطلب تفصيل مصاريف الصيانة قبل الموافقة' : 'موافق',
            votedAt: new Date(),
          }));
          await tx.insert(ownerApprovals).values(approvalRows).onConflictDoNothing();
        }
      }

      // --------------------------------------------------------------- vendors
      await tx
        .insert(vendors)
        .values(
          VENDORS.map((v) => ({
            id: uid(`vendor:${v.key}`),
            organizationId: ORG_ID,
            nameEn: v.en,
            nameAr: v.ar,
            phone: '+9626555700' + String(10 + VENDORS.indexOf(v)),
            email: `${v.key}@vendors.example.com`,
            trades: [...v.trades],
            coverageAreas: [
              { city: 'Amman', district: 'Jabal Al-Weibdeh' },
              { city: 'Amman', district: 'Abdoun' },
            ],
            rates: { calloutFils: jod(25), hourlyFils: jod(12), emergencyMultiplierBps: 15000 },
            insuranceCertExpiry: isoDateDaysFromNow(v.expiryDays),
            licence: `JOR-${v.key.toUpperCase()}-2024`,
            rating: v.rating,
            allowListed: true,
            notes: null,
          })),
        )
        .onConflictDoNothing();

      // --------------------------------------------------------------- tickets
      const allTickets = [...CURRENT_TICKETS.map((t) => ({ ...t, past: false })), ...CLOSED_PAST_TICKETS.map((t) => ({ ...t, past: true }))];
      const ticketValues = allTickets.map((t, i) => {
        const precheck = emergencyPrecheck(t.body);
        const unit = unitRows[i % unitRows.length];
        const lease = leaseRows[i % leaseRows.length];
        const openedAt = new Date(Date.now() - t.daysAgo * 86_400_000 - (i % 12) * 3_600_000);
        const closed = t.status === 'closed';
        return {
          id: uid(`ticket:${t.past ? 'past' : 'current'}:${i}`),
          organizationId: ORG_ID,
          propertyId: unit === undefined ? uid('property:weibdeh') : unit.propertyId,
          unitId: unit === undefined ? null : unit.id,
          tenantId: lease === undefined ? null : lease.tenantId,
          channel: (i % 3 === 0 ? 'whatsapp' : i % 3 === 1 ? 'in_app' : 'phone') as 'whatsapp' | 'in_app' | 'phone',
          status: t.status,
          openedAt,
          closedAt: closed ? new Date(openedAt.getTime() + 3 * 86_400_000) : null,
          subject: t.subject,
          body: t.body,
          bodyLocale: t.locale,
          // LAW 2: the deterministic precheck decides the flag; it is never hand-set.
          emergencyFlag: precheck.emergency,
        };
      });
      const emergencyCount = ticketValues.filter((t) => t.emergencyFlag).length;
      if (emergencyCount < 3) {
        throw new Error(`seed requires 3 emergency tickets, emergencyPrecheck flagged ${emergencyCount}`);
      }
      await tx.insert(tickets).values(ticketValues).onConflictDoNothing();

      // LAW-2 trace: emergency tickets carry a deterministic classification row
      // so the UI can show WHY the flag is set. No model ran at seed time —
      // modelId stays null and the rationale says so; modelSeverity mirrors the
      // merged severity only because the column is NOT NULL.
      const emergencyClassifications = ticketValues
        .filter((t) => t.emergencyFlag)
        .map((t) => {
          const pre = emergencyPrecheck(t.body);
          const firstSignal = pre.signals[0];
          const category = (firstSignal !== undefined ? hazardSignalCategory(firstSignal) : undefined) ?? 'other';
          return {
            id: uid(`classification:${t.id}`),
            organizationId: ORG_ID,
            ticketId: t.id,
            category,
            severity: 'emergency' as const,
            emergencyFlag: true,
            confidence: '1.000',
            deterministicEmergency: true,
            modelSeverity: 'emergency' as const,
            rationale: `Deterministic pre-check signals: ${pre.signals.join(', ')}. No model run at seed time; LAW-2 floor applied.`,
            modelId: null,
            promptVersion: 'det-1.0.0',
            createdAt: t.openedAt,
          };
        });
      await tx.insert(classifications).values(emergencyClassifications).onConflictDoNothing();

      // ---------------------------------------------------------------- bank
      const statementKeys = ['stmt-oct', 'stmt-nov'] as const;
      const statementRows = statementKeys.map((key, i) => ({
        id: uid(`statement:${key}`),
        organizationId: ORG_ID,
        accountLabel: 'البنك العربي — حساب الإيجارات',
        bankName: 'Arab Bank',
        fileName: `${key}.csv`,
        importedAt: new Date(Date.now() - (i === 0 ? 34 : 3) * 86_400_000),
        lineCount: i === 0 ? 8 : 5,
        sourceHash: uid(`source-hash:${key}`).replace(/-/g, ''),
      }));
      await tx.insert(bankImports).values(statementRows).onConflictDoNothing();

      const periodsForBank = PERIODS[PERIODS.length - 2] ?? '2026-01';
      const sharedLines = [
        { day: 3, amountFils: jod(450), payer: 'أحمد محمود الخطيب', ref: 'RENT 101' },
        { day: 4, amountFils: jod(620), payer: 'سامر نبيل حدادين', ref: 'RENT 102' },
        { day: 5, amountFils: jod(380), payer: 'محمد خالد العبادي', ref: 'RENT 201' },
      ];
      const uniqueLines = [
        { day: 8, amountFils: jod(310), payer: 'MYSTERY TRANSFER / حوالة مجهولة', ref: 'NO REF' },
        { day: 12, amountFils: jod(495), payer: 'لينا عمر بركات', ref: 'RENT 202' },
        { day: 15, amountFils: jod(700), payer: 'YOUSEF AL-RAWASHDEH', ref: 'DEPOSIT' },
        { day: 21, amountFils: jod(410), payer: 'رنا سامي القضاة', ref: 'RENT 301' },
        { day: 26, amountFils: jod(380), payer: 'محمد خالد العبادي', ref: 'RENT 201' },
      ];

      const makeLine = (statementKey: string, index: number, spec: { day: number; amountFils: number; payer: string; ref: string }): {
        id: string;
        statementId: string;
        dateISO: string;
        amountFils: number;
        payerName: string;
        payerAccount: string | null;
        reference: string | null;
      } => {
        const line = {
          id: uid(`bank-line:${statementKey}:${index}`),
          statementId: uid(`statement:${statementKey}`),
          dateISO: `${periodsForBank}-${String(spec.day).padStart(2, '0')}`,
          amountFils: spec.amountFils,
          payerName: spec.payer,
          payerAccount: `JO94CBJO0010000000000131${String(100 + index)}`,
          reference: spec.ref,
        };
        return line;
      };

      const statementA = [...sharedLines, ...uniqueLines.slice(0, 5)].map((spec, i) => makeLine('stmt-oct', i, spec));
      // Statement B is an OVERLAPPING re-import: the same three transfers appear
      // again (identical date/amount/payer ⇒ identical fingerprint) plus two new
      // November lines. Both statements are stored in full — the schema allows a
      // fingerprint to repeat ACROSS statements (unique per statement_id only).
      // Deduplication is the reconciliation engine's job at match time, not the
      // importer's job at rest: hiding the overlap here would destroy the demo.
      const novemberOnly = [
        { day: 2, amountFils: jod(450), payer: 'أحمد محمود الخطيب', ref: 'RENT 101 NOV' },
        { day: 9, amountFils: jod(275), payer: 'هدى فؤاد النابلسي', ref: 'SERVICE NOV' },
      ];
      const statementB = [...sharedLines, ...novemberOnly].map((spec, i) => makeLine('stmt-nov', i, spec));
      // The engine still runs — we report what it WOULD dedupe, without dropping rows.
      const duplicatesAcrossStatements = statementB.length - dedupeBankLines(statementA, statementB).length;
      console.log(`  overlapping fingerprints across statements: ${duplicatesAcrossStatements}`);
      const allBankLines = [...statementA, ...statementB];

      await tx
        .insert(bankLines)
        .values(
          allBankLines.map((l) => ({
            id: l.id,
            organizationId: ORG_ID,
            statementId: l.statementId,
            date: l.dateISO,
            amountFils: l.amountFils,
            payerName: l.payerName,
            payerAccount: l.payerAccount,
            reference: l.reference,
            fingerprint: fingerprintBankLine({
              id: l.id,
              statementId: l.statementId,
              dateISO: l.dateISO,
              amountFils: l.amountFils,
              payerName: l.payerName,
              payerAccount: l.payerAccount,
              reference: l.reference,
            }),
          })),
        )
        .onConflictDoNothing();

      // Ambiguous payer: same amount, two candidate leases -> human must decide.
      const ambiguousAmount = jod(380);
      const candidateLeases = leaseRows.filter((l) => l.unit.unitNumber === '201' || l.unit.unitNumber === '102');
      const ambiguousLineId = statementA[2]?.id ?? '';
      if (ambiguousLineId.length > 0) {
        await tx
          .insert(matchSuggestions)
          .values([
            {
              id: uid('match:ambiguous'),
              organizationId: ORG_ID,
              bankLineId: ambiguousLineId,
              kind: 'ambiguous' as const,
              leaseIds: candidateLeases.map((l) => l.id),
              payerId: null,
              amountFils: ambiguousAmount,
              confidence: '0.5',
              reason: 'نفس المبلغ يطابق عقدين — مطلوب تأكيد بشري (same amount matches two leases)',
              acceptedAt: null,
            },
            {
              id: uid('match:unknown'),
              organizationId: ORG_ID,
              bankLineId: statementA[3]?.id ?? ambiguousLineId,
              kind: 'unknown_payer' as const,
              leaseIds: [],
              payerId: null,
              amountFils: jod(310),
              confidence: '0',
              reason: 'حوالة مجهولة بدون رقم مرجعي — لا يوجد مستأجر مطابق',
              acceptedAt: null,
            },
          ])
          .onConflictDoNothing();
      }

      // ----------------------------------------------------------- audit trail
      const existingAudit = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.idempotencyKey, 'seed:aqar-demo:v1'));
      if (existingAudit.length === 0) {
        await tx.insert(auditEvents).values({
          id: uid('audit:seed'),
          organizationId: ORG_ID,
          actor: { type: 'system', component: 'system:seed' },
          action: 'seed.run',
          entityType: 'organization',
          entityId: ORG_ID,
          before: null,
          after: { slug: SEED_ORG_SLUG, units: unitRows.length, tickets: ticketValues.length },
          modelId: null,
          promptVersion: null,
          confidence: null,
          toolCalls: [],
          idempotencyKey: 'seed:aqar-demo:v1',
          occurredAt: new Date(),
          reversalOf: null,
        });
      }
    });

    // ------------------------------------------------------------------ counts
    const count = async (rows: Promise<{ n: number }[]>): Promise<number> => {
      const result = await rows;
      return result[0]?.n ?? 0;
    };
    const n = sql<number>`count(*)::int`;

    const counts: SeedCounts = {
      users: await count(db.select({ n }).from(users).where(eq(users.organizationId, ORG_ID))),
      properties: await count(db.select({ n }).from(properties).where(eq(properties.organizationId, ORG_ID))),
      buildings: await count(db.select({ n }).from(buildings).where(eq(buildings.organizationId, ORG_ID))),
      units: await count(db.select({ n }).from(units).where(eq(units.organizationId, ORG_ID))),
      tenants: await count(db.select({ n }).from(tenants).where(eq(tenants.organizationId, ORG_ID))),
      leases: await count(db.select({ n }).from(leases).where(eq(leases.organizationId, ORG_ID))),
      charges: await count(db.select({ n }).from(charges).where(eq(charges.organizationId, ORG_ID))),
      payments: await count(db.select({ n }).from(payments).where(eq(payments.organizationId, ORG_ID))),
      allocations: await count(
        db.select({ n }).from(paymentAllocations).where(eq(paymentAllocations.organizationId, ORG_ID)),
      ),
      journalEntries: await count(
        db.select({ n }).from(journalEntries).where(eq(journalEntries.organizationId, ORG_ID)),
      ),
      vendors: await count(db.select({ n }).from(vendors).where(eq(vendors.organizationId, ORG_ID))),
      tickets: await count(db.select({ n }).from(tickets).where(eq(tickets.organizationId, ORG_ID))),
      emergencyTickets: await count(
        db
          .select({ n })
          .from(tickets)
          .where(sql`${tickets.organizationId} = ${ORG_ID} and ${tickets.emergencyFlag} = true`),
      ),
      bankStatements: await count(db.select({ n }).from(bankImports).where(eq(bankImports.organizationId, ORG_ID))),
      bankLines: await count(db.select({ n }).from(bankLines).where(eq(bankLines.organizationId, ORG_ID))),
      owners: await count(db.select({ n }).from(owners).where(eq(owners.organizationId, ORG_ID))),
      ownershipShares: await count(
        db.select({ n }).from(ownershipShares).where(eq(ownershipShares.organizationId, ORG_ID)),
      ),
      auditEvents: await count(db.select({ n }).from(auditEvents).where(eq(auditEvents.organizationId, ORG_ID))),
    };
    return counts;
  } finally {
    await client.end({ timeout: 5 });
  }
}

function printCounts(counts: SeedCounts): void {
  const rows: [string, number][] = [
    ['users', counts.users],
    ['properties', counts.properties],
    ['buildings', counts.buildings],
    ['units', counts.units],
    ['tenants', counts.tenants],
    ['leases', counts.leases],
    ['charges', counts.charges],
    ['payments', counts.payments],
    ['allocations', counts.allocations],
    ['journal entries', counts.journalEntries],
    ['vendors', counts.vendors],
    ['tickets', counts.tickets],
    ['  of which emergency', counts.emergencyTickets],
    ['bank statements', counts.bankStatements],
    ['bank lines', counts.bankLines],
    ['owners', counts.owners],
    ['ownership shares', counts.ownershipShares],
    ['audit events', counts.auditEvents],
  ];
  console.log(`seed: ${SEED_ORG_SLUG} (organization ${ORG_ID})`);
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(22, '.')} ${value}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('seed.ts');

if (invokedDirectly) {
  runSeed()
    .then((counts) => {
      printCounts(counts);
    })
    .catch((error: unknown) => {
      if (error instanceof Error) {
        const cause = (error as { cause?: unknown }).cause;
        console.error('seed failed:', error.message.split('\n')[0]);
        if (cause !== undefined) console.error('cause:', cause instanceof Error ? `${cause.name}: ${cause.message}` : JSON.stringify(cause));
        console.error(error.stack ?? error.message);
      } else {
        console.error(String(error));
      }
      process.exitCode = 1;
    });
}
