/**
 * Deterministic date and time handling, always in the shop's timezone.
 *
 * LLMs are unreliable at calendar arithmetic ("what date is Thursday?"), so the model
 * passes the day the way the caller said it and this module resolves it. Every tool
 * result echoes the resolved weekday and date so the agent reads it back to the caller.
 */
import { DateTime, Info } from 'luxon';
import { config } from './config.js';
import { HOURS, SHOP } from './shop.js';

export type Clock = () => DateTime;

export const systemClock: Clock = () => DateTime.now().setZone(SHOP.timezone);

export function fixedClock(iso: string): Clock {
  const dt = DateTime.fromISO(iso, { zone: SHOP.timezone });
  if (!dt.isValid) throw new Error(`Invalid clock time: ${iso}`);
  return () => dt;
}

export function inShopZone(iso: string): DateTime {
  return DateTime.fromISO(iso, { setZone: true }).setZone(SHOP.timezone);
}

// ---------- formatting ----------

/** "Thursday, October 8" (year added only when it is not the current year). */
export function fmtDay(dt: DateTime, now?: DateTime): string {
  const base = dt.toFormat('cccc, LLLL d');
  return now && dt.year !== now.year ? `${base}, ${dt.year}` : base;
}

/** "4:30 PM" */
export function fmtTime(dt: DateTime): string {
  return dt.toFormat('h:mm a');
}

/** "Thursday, October 8 at 4:30 PM" */
export function fmtDayTime(dt: DateTime, now?: DateTime): string {
  return `${fmtDay(dt, now)} at ${fmtTime(dt)}`;
}

/** "Thu Oct 8, 4:30 PM" for spreadsheet cells. */
export function fmtShort(dt: DateTime): string {
  return dt.toFormat('ccc LLL d, h:mm a');
}

export function isoDate(dt: DateTime): string {
  return dt.toFormat('yyyy-LL-dd');
}

export function hhmm(dt: DateTime): string {
  return dt.toFormat('HH:mm');
}

// ---------- opening hours ----------

export function hoursFor(day: DateTime): { open: DateTime; close: DateTime } | null {
  const h = HOURS[day.weekday];
  if (!h) return null;
  const [oh, om] = h.open.split(':').map(Number);
  const [ch, cm] = h.close.split(':').map(Number);
  const start = day.startOf('day');
  return {
    open: start.set({ hour: oh, minute: om }),
    close: start.set({ hour: ch, minute: cm }),
  };
}

export function hoursLabel(day: DateTime): string {
  const h = hoursFor(day);
  return h ? `${fmtTime(h.open)} to ${fmtTime(h.close)}` : 'closed';
}

export function isOpenNow(now: DateTime): boolean {
  const h = hoursFor(now);
  return !!h && now >= h.open && now < h.close;
}

// ---------- date resolution ----------

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const WEEKDAY_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const PART_OF_DAY = '(?: (?:morning|afternoon|evening|night))?';

export type DateResolution =
  | {
      ok: true;
      day: DateTime;
      /**
       * Set when the caller named today's weekday with nothing else ("Thursday", said on a
       * Thursday). If the time they want has already gone, they mean next week.
       */
      bareWeekdayToday?: boolean;
    }
  | { ok: false; reason: 'unparseable' | 'ambiguous' | 'weekday_mismatch'; message: string };

/**
 * Resolve what a caller said ("Thursday", "tomorrow", "Oct 8", "10/8", "2026-10-08")
 * to a calendar day in the shop timezone. Never guesses: anything unclear comes back
 * as an error message telling the agent what to ask.
 */
export function resolveDate(input: string, now: DateTime): DateResolution {
  const today = now.startOf('day');
  const raw = (input ?? '').trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(raw);
  if (iso) {
    const day = DateTime.fromObject(
      { year: +iso[1], month: +iso[2], day: +iso[3] },
      { zone: SHOP.timezone },
    );
    return day.isValid ? { ok: true, day } : unparseable(input);
  }

  const s = raw
    .toLowerCase()
    .replace(/[,.]/g, ' ')
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, '$1')
    .replace(/\b(on|the|of)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return unparseable(input);

  if (new RegExp(`^(today|tonight|now|this (morning|afternoon|evening))$`).test(s)) return { ok: true, day: today };
  if (new RegExp(`^(tomorrow|tmrw|tmr)${PART_OF_DAY}$`).test(s)) return { ok: true, day: today.plus({ days: 1 }) };
  if (/^day after tomorrow$/.test(s)) return { ok: true, day: today.plus({ days: 2 }) };

  const inDays = /^(?:in )?(\d{1,2}) days?(?: from (?:now|today))?$/.exec(s);
  if (inDays) return { ok: true, day: today.plus({ days: +inDays[1] }) };
  if (/^(in )?(a|one|1) week( from (now|today))?$/.test(s)) return { ok: true, day: today.plus({ days: 7 }) };

  // "thursday", "this thursday", "next thursday", "thursday afternoon"
  const wd = new RegExp(`^(this coming|this|next|coming)? ?(${WEEKDAY_RE})${PART_OF_DAY}$`).exec(s);
  if (wd) {
    const target = WEEKDAYS[wd[2]];
    const delta = (target - today.weekday + 7) % 7;
    const upcoming = today.plus({ days: delta });
    if (wd[1] === 'next') {
      if (delta === 0) return { ok: true, day: today.plus({ days: 7 }) };
      if (target > today.weekday) {
        // Still later this same week: "next Thursday" could mean either one.
        const later = upcoming.plus({ days: 7 });
        return {
          ok: false,
          reason: 'ambiguous',
          message:
            `"${input}" could mean ${fmtDay(upcoming, now)} (${isoDate(upcoming)}) or ${fmtDay(later, now)} (${isoDate(later)}). ` +
            'Ask the caller which date they mean, then call again with the YYYY-MM-DD date.',
        };
      }
    }
    return { ok: true, day: upcoming, ...(delta === 0 && !wd[1] ? { bareWeekdayToday: true } : {}) };
  }

  // Optional leading weekday followed by an explicit date: "thursday october 8"
  let rest = s;
  let claimedWeekday: number | undefined;
  const lead = new RegExp(`^(${WEEKDAY_RE}) (.+)$`).exec(s);
  if (lead) {
    claimedWeekday = WEEKDAYS[lead[1]];
    rest = lead[2];
  }

  let month: number | undefined;
  let dayNum: number | undefined;
  let year: number | undefined;

  let m = new RegExp(`^(${MONTH_RE}) (\\d{1,2})(?: (\\d{4}))?$`).exec(rest);
  if (m) {
    month = MONTHS[m[1]];
    dayNum = +m[2];
    year = m[3] ? +m[3] : undefined;
  }
  if (!m) {
    m = new RegExp(`^(\\d{1,2}) (${MONTH_RE})(?: (\\d{4}))?$`).exec(rest);
    if (m) {
      dayNum = +m[1];
      month = MONTHS[m[2]];
      year = m[3] ? +m[3] : undefined;
    }
  }
  if (!m) {
    // US style month/day
    m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(rest);
    if (m) {
      month = +m[1];
      dayNum = +m[2];
      year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined;
    }
  }

  let day: DateTime | undefined;
  if (m && month && dayNum) {
    day = DateTime.fromObject({ year: year ?? today.year, month, day: dayNum }, { zone: SHOP.timezone });
    if (!day.isValid) return unparseable(input);
    if (!year && day < today) {
      day = day.plus({ years: 1 });
      if (!day.isValid) return unparseable(input);
    }
  } else {
    // "the 8th" -> next time that day of the month comes around
    const dom = /^(\d{1,2})$/.exec(rest);
    if (dom) {
      const n = +dom[1];
      for (let i = 0; i < 3 && !day; i++) {
        const candidate = today.startOf('month').plus({ months: i }).set({ day: n });
        if (candidate.isValid && candidate.day === n && candidate >= today) day = candidate;
      }
    }
  }
  if (!day) return unparseable(input);

  if (claimedWeekday && day.weekday !== claimedWeekday) {
    return {
      ok: false,
      reason: 'weekday_mismatch',
      message:
        `${day.toFormat('LLLL d')} is a ${day.toFormat('cccc')}, not a ${Info.weekdays('long', { locale: 'en-US' })[claimedWeekday - 1]}. ` +
        'Ask the caller which day they mean.',
    };
  }
  return { ok: true, day };
}

function unparseable(input: string): DateResolution {
  return {
    ok: false,
    reason: 'unparseable',
    message: `Could not understand the date "${input}". Ask the caller for the day, then pass it as YYYY-MM-DD or a plain weekday like "Thursday".`,
  };
}

// ---------- time resolution ----------

export type TimeResolution =
  | { ok: true; hour: number; minute: number }
  | { ok: false; message: string };

/**
 * Parse "15:30", "3:30 PM", "3pm", "3:30", "noon".
 * A bare 1-7 with no AM/PM is taken as afternoon and 8-11 as morning, which is the
 * only reading that fits the shop's hours. The resolved time is always echoed back.
 */
export function parseTime(input: string): TimeResolution {
  const raw = (input ?? '').trim().toLowerCase();
  const s = raw.replace(/\./g, '').replace(/o'?clock/g, '').replace(/\s+/g, ' ').trim();
  const bad: TimeResolution = {
    ok: false,
    message: `Could not understand the time "${input}". Pass it as 24-hour HH:MM, for example 15:30.`,
  };
  if (!s) return bad;
  if (s === 'noon' || s === 'midday' || s === '12 noon') return { ok: true, hour: 12, minute: 0 };

  const m = /^(\d{1,2})(?::?(\d{2}))? ?(am|pm|a|p)?$/.exec(s);
  if (!m) return bad;
  let hour = +m[1];
  const minute = m[2] ? +m[2] : 0;
  const meridiem = m[3]?.[0];
  if (minute > 59) return bad;

  if (meridiem) {
    if (hour < 1 || hour > 12) return bad;
    if (meridiem === 'p' && hour !== 12) hour += 12;
    if (meridiem === 'a' && hour === 12) hour = 0;
  } else if (/^\d{2}:\d{2}$/.test(s) || hour === 0 || hour >= 13) {
    // Zero-padded or clearly 24-hour: take literally.
    if (hour > 23) return bad;
  } else if (hour >= 1 && hour <= 7) {
    hour += 12;
  }
  return { ok: true, hour, minute };
}

// ---------- phone numbers ----------

/**
 * Normalise to E.164. Ten digits get the default country code (+1 unless
 * DEFAULT_COUNTRY_CODE is set). Returns null when the digits cannot be a complete
 * phone number, so the agent re-asks instead of storing junk.
 */
export function normalizePhone(input: string | undefined | null): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    // North American numbers are always exactly 11 digits with the country code.
    if (digits.startsWith('1')) return digits.length === 11 ? `+${digits}` : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const cc = config.defaultCountryCode;
  if (digits.length === 10) return `+${cc}${digits}`;
  if (digits.length === 10 + cc.length && digits.startsWith(cc)) return `+${digits}`;
  return null;
}

/** "+14155550190" -> "(415) 555-0190" */
export function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** Digits used to compare numbers regardless of formatting or country prefix. */
export function phoneKey(input: string | undefined | null): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
