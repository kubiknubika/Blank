import type { Application } from '../types';

export function formatSalary(
  app: Pick<Application, 'salaryMin' | 'salaryMax' | 'currency'>,
): string | null {
  const { salaryMin, salaryMax, currency } = app;
  if (salaryMin == null && salaryMax == null) return null;
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const symbol =
    currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency === 'RUB' ? '₽' : `${currency} `;
  if (salaryMin != null && salaryMax != null) return `${symbol}${fmt(salaryMin)}–${fmt(salaryMax)}`;
  if (salaryMin != null) return `${symbol}${fmt(salaryMin)}+`;
  return `up to ${symbol}${fmt(salaryMax!)}`;
}

export function daysSince(dateStr: string | null, now: Date = new Date()): number | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86400000));
}

export function relativeDays(dateStr: string | null, now: Date = new Date()): string {
  const days = daysSince(dateStr, now);
  if (days == null) return '';
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

export function companyInitials(company: string): string {
  return company
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

const AVATAR_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
];

export function companyColor(company: string): string {
  let hash = 0;
  for (let i = 0; i < company.length; i++) {
    hash = (hash * 31 + company.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
