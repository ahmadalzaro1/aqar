// Clock helpers for the worker. Policy needs the tenant's LOCAL hour (quiet
// hours are expressed in property-local time), so we derive Asia/Amman from the
// injected instant instead of reading the wall clock anywhere else.
// @aqar/core is clock-free by law; this file is the only place time zones appear.

const AMMAN_HOUR_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Amman',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** Local hour (0..23) in Asia/Amman for the given instant. */
export function ammanLocalHour(at: Date): number {
  const parts = AMMAN_HOUR_FORMAT.formatToParts(at);
  const hourPart = parts.find((part) => part.type === 'hour');
  if (hourPart === undefined) {
    throw new Error('Intl returned no hour part for Asia/Amman');
  }
  const hour = Number(hourPart.value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Intl returned an out-of-range Asia/Amman hour: ${hourPart.value}`);
  }
  return hour;
}
