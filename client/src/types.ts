/**
 * The domain contract comes from @offerflow/shared — the same package the
 * server validates against. This file only adds UI-specific presentation
 * metadata (labels, colors), which is deliberately not part of the contract.
 */
export * from '@offerflow/shared';

import type { Priority, Source, Status, WorkMode } from '@offerflow/shared';

export const STATUS_META: Record<Status, { label: string; color: string }> = {
  wishlist: { label: 'Wishlist', color: '#94a3b8' },
  applied: { label: 'Applied', color: '#60a5fa' },
  screening: { label: 'Screening', color: '#a78bfa' },
  interview: { label: 'Interview', color: '#fbbf24' },
  offer: { label: 'Offer', color: '#34d399' },
  rejected: { label: 'Rejected', color: '#f87171' },
};

export const SOURCE_LABELS: Record<Source, string> = {
  linkedin: 'LinkedIn',
  referral: 'Referral',
  job_board: 'Job board',
  company_site: 'Company site',
  recruiter: 'Recruiter',
  other: 'Other',
};

export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};
