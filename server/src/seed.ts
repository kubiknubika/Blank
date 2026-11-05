import type { Status, Source, Priority, WorkMode } from '@offerflow/shared';
import type { UserScope } from './service.js';

interface SeedItem {
  company: string;
  position: string;
  status: Status;
  source: Source;
  priority: Priority;
  location: string;
  workMode: WorkMode;
  salaryMin: number;
  salaryMax: number;
  daysAgoApplied: number | null;
  /** Follow-up date offset from today (negative = overdue). */
  followUpInDays?: number;
  notes?: string;
}

const SEED: SeedItem[] = [
  {
    company: 'Spotify',
    position: 'Senior Frontend Engineer',
    status: 'interview',
    source: 'linkedin',
    priority: 'high',
    location: 'Berlin, DE',
    workMode: 'hybrid',
    salaryMin: 85000,
    salaryMax: 105000,
    daysAgoApplied: 21,
    followUpInDays: 0, // today: prep the interview
    notes:
      '**Tech interview scheduled**\n\n- prepare system design: news feed\n- review `STAR` stories\n- [prep doc](https://example.com/interview-prep)',
  },
  {
    company: 'Zalando',
    position: 'Fullstack Developer (React/Node)',
    status: 'screening',
    source: 'company_site',
    priority: 'medium',
    location: 'Berlin, DE',
    workMode: 'hybrid',
    salaryMin: 70000,
    salaryMax: 90000,
    daysAgoApplied: 12,
    followUpInDays: -2, // overdue: chase the recruiter
  },
  {
    company: 'N26',
    position: 'Frontend Engineer, Web Platform',
    status: 'offer',
    source: 'referral',
    priority: 'high',
    location: 'Berlin, DE',
    workMode: 'remote',
    salaryMin: 80000,
    salaryMax: 95000,
    daysAgoApplied: 35,
    followUpInDays: 3, // upcoming: reply about the start date
    notes: 'Offer received! Negotiating start date.',
  },
  {
    company: 'Delivery Hero',
    position: 'Software Engineer, Checkout',
    status: 'applied',
    source: 'linkedin',
    priority: 'medium',
    location: 'Berlin, DE',
    workMode: 'hybrid',
    salaryMin: 72000,
    salaryMax: 88000,
    daysAgoApplied: 5,
  },
  {
    company: 'HelloFresh',
    position: 'React Engineer, Growth',
    status: 'rejected',
    source: 'job_board',
    priority: 'low',
    location: 'Berlin, DE',
    workMode: 'onsite',
    salaryMin: 65000,
    salaryMax: 80000,
    daysAgoApplied: 28,
    notes: 'Rejected after take-home. Feedback: state management approach.',
  },
  {
    company: 'FlixBus',
    position: 'Fullstack Engineer (TypeScript)',
    status: 'applied',
    source: 'company_site',
    priority: 'medium',
    location: 'Munich, DE',
    workMode: 'hybrid',
    salaryMin: 68000,
    salaryMax: 85000,
    daysAgoApplied: 3,
  },
  {
    company: 'Personio',
    position: 'Product Engineer',
    status: 'interview',
    source: 'recruiter',
    priority: 'high',
    location: 'Munich, DE',
    workMode: 'remote',
    salaryMin: 78000,
    salaryMax: 98000,
    daysAgoApplied: 18,
  },
  {
    company: 'Celonis',
    position: 'Frontend Engineer, UI Platform',
    status: 'screening',
    source: 'linkedin',
    priority: 'medium',
    location: 'Munich, DE',
    workMode: 'hybrid',
    salaryMin: 75000,
    salaryMax: 92000,
    daysAgoApplied: 9,
  },
  {
    company: 'Revolut',
    position: 'Frontend Engineer (React)',
    status: 'applied',
    source: 'referral',
    priority: 'high',
    location: 'Remote, EU',
    workMode: 'remote',
    salaryMin: 70000,
    salaryMax: 100000,
    daysAgoApplied: 2,
  },
  {
    company: 'Klarna',
    position: 'Fullstack Engineer, Shopping',
    status: 'wishlist',
    source: 'linkedin',
    priority: 'medium',
    location: 'Berlin, DE',
    workMode: 'hybrid',
    salaryMin: 72000,
    salaryMax: 90000,
    daysAgoApplied: null,
  },
  {
    company: 'SumUp',
    position: 'Web Engineer, Dashboard',
    status: 'wishlist',
    source: 'job_board',
    priority: 'low',
    location: 'Berlin, DE',
    workMode: 'hybrid',
    salaryMin: 65000,
    salaryMax: 82000,
    daysAgoApplied: null,
  },
  {
    company: 'GetYourGuide',
    position: 'Senior React Engineer',
    status: 'applied',
    source: 'company_site',
    priority: 'high',
    location: 'Berlin, DE',
    workMode: 'hybrid',
    salaryMin: 80000,
    salaryMax: 96000,
    daysAgoApplied: 7,
  },
  {
    company: 'Trade Republic',
    position: 'Frontend Engineer, Trading',
    status: 'screening',
    source: 'recruiter',
    priority: 'high',
    location: 'Berlin, DE',
    workMode: 'onsite',
    salaryMin: 82000,
    salaryMax: 105000,
    daysAgoApplied: 14,
  },
  {
    company: 'Contentful',
    position: 'Fullstack Engineer (Node/React)',
    status: 'rejected',
    source: 'linkedin',
    priority: 'medium',
    location: 'Berlin, DE',
    workMode: 'remote',
    salaryMin: 75000,
    salaryMax: 95000,
    daysAgoApplied: 30,
  },
  {
    company: 'SoundCloud',
    position: 'Web Platform Engineer',
    status: 'wishlist',
    source: 'referral',
    priority: 'medium',
    location: 'Berlin, DE',
    workMode: 'hybrid',
    salaryMin: 70000,
    salaryMax: 88000,
    daysAgoApplied: null,
  },
  {
    company: 'Wolt',
    position: 'Frontend Engineer, Consumer Web',
    status: 'applied',
    source: 'job_board',
    priority: 'medium',
    location: 'Berlin, DE',
    workMode: 'remote',
    salaryMin: 68000,
    salaryMax: 86000,
    daysAgoApplied: 1,
  },
];

export function seedDatabase(service: UserScope): void {
  const now = Date.now();
  for (const item of SEED) {
    const appliedAt =
      item.daysAgoApplied != null
        ? new Date(now - item.daysAgoApplied * 86400000).toISOString().slice(0, 10)
        : null;
    const followUpAt =
      item.followUpInDays != null
        ? new Date(now + item.followUpInDays * 86400000).toISOString().slice(0, 10)
        : null;
    const app = service.create({
      company: item.company,
      position: item.position,
      status: item.status,
      source: item.source,
      priority: item.priority,
      location: item.location,
      workMode: item.workMode,
      salaryMin: item.salaryMin,
      salaryMax: item.salaryMax,
      currency: 'EUR',
      url: null,
      notes: item.notes ?? null,
      appliedAt,
      followUpAt,
    });
    if (item.status === 'interview') {
      service.addEvent(app.id, { type: 'task', message: 'Prepare for the technical interview' });
    }
    if (item.status === 'offer') {
      service.addEvent(app.id, { type: 'email', message: 'Received the offer letter 🎉' });
    }
  }
}
