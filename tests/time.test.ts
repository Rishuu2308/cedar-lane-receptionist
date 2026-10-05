import { describe, expect, it } from 'vitest';
import { fixedClock, isoDate, normalizePhone, parseTime, phoneKey, prettyPhone, resolveDate } from '../src/time.js';
import { MONDAY_10AM } from './helpers.js';

const now = fixedClock(MONDAY_10AM)(); // Monday 2026-10-05

function day(input: string, from = now): string {
  const r = resolveDate(input, from);
  if (!r.ok) throw new Error(`${input} -> ${r.reason}: ${r.message}`);
  return isoDate(r.day);
}

describe('resolveDate', () => {
  it('resolves relative words', () => {
    expect(day('today')).toBe('2026-10-05');
    expect(day('Tomorrow')).toBe('2026-10-06');
    expect(day('tomorrow afternoon')).toBe('2026-10-06');
    expect(day('day after tomorrow')).toBe('2026-10-07');
    expect(day('in 3 days')).toBe('2026-10-08');
  });

  it('resolves weekday names to the next occurrence, today included', () => {
    expect(day('Thursday')).toBe('2026-10-08');
    expect(day('thurs')).toBe('2026-10-08');
    expect(day('this Friday')).toBe('2026-10-09');
    expect(day('on Sunday')).toBe('2026-10-11');
    expect(day('monday')).toBe('2026-10-05');
    expect(day('Thursday morning')).toBe('2026-10-08');
  });

  it('refuses to guess what "next Thursday" means when Thursday is still ahead this week', () => {
    const r = resolveDate('next Thursday', now);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous');
      expect(r.message).toContain('2026-10-08');
      expect(r.message).toContain('2026-10-15');
    }
  });

  it('treats "next <weekday>" as unambiguous when only one reading exists', () => {
    expect(day('next Monday')).toBe('2026-10-12'); // said on a Monday
    const friday = fixedClock('2026-10-09T10:00:00')();
    expect(day('next Tuesday', friday)).toBe('2026-10-13');
  });

  it('resolves explicit dates', () => {
    expect(day('2026-10-08')).toBe('2026-10-08');
    expect(day('October 8')).toBe('2026-10-08');
    expect(day('Oct 8th')).toBe('2026-10-08');
    expect(day('8 October')).toBe('2026-10-08');
    expect(day('the 8th of October')).toBe('2026-10-08');
    expect(day('10/8')).toBe('2026-10-08');
    expect(day('10/8/2026')).toBe('2026-10-08');
    expect(day('the 8th')).toBe('2026-10-08');
    expect(day('the 2nd')).toBe('2026-11-02'); // already passed this month
    expect(day('Thursday, October 8')).toBe('2026-10-08');
  });

  it('rolls a year-less date that has passed into next year', () => {
    expect(day('January 12')).toBe('2027-01-12');
  });

  it('catches a weekday that does not match the date', () => {
    const r = resolveDate('Friday October 8', now);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('weekday_mismatch');
      expect(r.message).toContain('Thursday');
    }
  });

  it('rejects nonsense instead of guessing', () => {
    for (const bad of ['', 'sometime soon', 'next week', 'February 30', '2026-13-40', '13/45']) {
      expect(resolveDate(bad, now).ok, bad).toBe(false);
    }
  });

  it('uses the shop timezone for "today", not UTC', () => {
    // 11:30 PM Monday in Los Angeles is already Tuesday in UTC.
    const lateMonday = fixedClock('2026-10-05T23:30:00')();
    expect(day('today', lateMonday)).toBe('2026-10-05');
    expect(day('tomorrow', lateMonday)).toBe('2026-10-06');
  });
});

describe('parseTime', () => {
  const t = (s: string) => {
    const r = parseTime(s);
    if (!r.ok) throw new Error(`${s}: ${r.message}`);
    return `${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`;
  };

  it('parses 24-hour and 12-hour forms', () => {
    expect(t('15:30')).toBe('15:30');
    expect(t('08:00')).toBe('08:00');
    expect(t('3:30 PM')).toBe('15:30');
    expect(t('3:30pm')).toBe('15:30');
    expect(t('3 p.m.')).toBe('15:00');
    expect(t('9am')).toBe('09:00');
    expect(t('12pm')).toBe('12:00');
    expect(t('12am')).toBe('00:00');
    expect(t('noon')).toBe('12:00');
    expect(t('4 o\'clock')).toBe('16:00');
  });

  it('reads a bare hour the only way that fits business hours', () => {
    expect(t('3:30')).toBe('15:30');
    expect(t('4')).toBe('16:00');
    expect(t('9:30')).toBe('09:30');
    expect(t('11')).toBe('11:00');
    expect(t('12:30')).toBe('12:30');
  });

  it('takes zero-padded times literally', () => {
    expect(t('07:00')).toBe('07:00');
  });

  it('rejects invalid times', () => {
    for (const bad of ['', 'later', '25:00', '3:75', '13pm', 'half past three']) {
      expect(parseTime(bad).ok, bad).toBe(false);
    }
  });
});

describe('phone numbers', () => {
  it('normalises US numbers to E.164', () => {
    expect(normalizePhone('415-555-0190')).toBe('+14155550190');
    expect(normalizePhone('(415) 555 0190')).toBe('+14155550190');
    expect(normalizePhone('1 415 555 0190')).toBe('+14155550190');
    expect(normalizePhone('+14155550190')).toBe('+14155550190');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('rejects incomplete numbers', () => {
    for (const bad of ['555-0190', '415555019', '41555501901234', '', undefined, 'my number']) {
      expect(normalizePhone(bad as string), String(bad)).toBeNull();
    }
  });

  it('formats and compares', () => {
    expect(prettyPhone('+14155550190')).toBe('(415) 555-0190');
    expect(phoneKey('+1 (415) 555-0190')).toBe(phoneKey('4155550190'));
  });
});
