import { describe, it, expect } from 'vitest';
import { formatSalary, daysSince, relativeDays, companyInitials, companyColor } from './format';

describe('formatSalary', () => {
  it('formats a range with k-suffix', () => {
    expect(formatSalary({ salaryMin: 70000, salaryMax: 90000, currency: 'EUR' })).toBe('€70k–90k');
  });
  it('formats min-only as plus', () => {
    expect(formatSalary({ salaryMin: 80000, salaryMax: null, currency: 'USD' })).toBe('$80k+');
  });
  it('formats max-only', () => {
    expect(formatSalary({ salaryMin: null, salaryMax: 60000, currency: 'EUR' })).toBe('up to €60k');
  });
  it('returns null when no salary', () => {
    expect(formatSalary({ salaryMin: null, salaryMax: null, currency: 'EUR' })).toBeNull();
  });
  it('handles unknown currency codes', () => {
    expect(formatSalary({ salaryMin: 5000, salaryMax: null, currency: 'CHF' })).toBe('CHF 5k+');
  });
});

describe('daysSince / relativeDays', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  it('computes whole days', () => {
    expect(daysSince('2026-11-01', now)).toBe(3);
  });
  it('returns null for missing date', () => {
    expect(daysSince(null, now)).toBeNull();
  });
  it('never returns negative values for future dates', () => {
    expect(daysSince('2026-12-01', now)).toBe(0);
  });
  it('formats relative labels', () => {
    expect(relativeDays('2026-11-04', now)).toBe('today');
    expect(relativeDays('2026-11-03', now)).toBe('1 day ago');
    expect(relativeDays('2026-10-20', now)).toBe('15 days ago');
    expect(relativeDays('2026-09-01', now)).toBe('2 months ago');
  });
});

describe('company helpers', () => {
  it('builds initials from up to two words', () => {
    expect(companyInitials('Delivery Hero')).toBe('DH');
    expect(companyInitials('Spotify')).toBe('S');
    expect(companyInitials('Get Your Guide')).toBe('GY');
  });
  it('assigns a stable color per company', () => {
    expect(companyColor('Spotify')).toBe(companyColor('Spotify'));
    expect(companyColor('Spotify')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
