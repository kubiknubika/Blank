export const STATUSES = [
  'wishlist',
  'applied',
  'screening',
  'interview',
  'offer',
  'rejected',
] as const;
export type Status = (typeof STATUSES)[number];

export const SOURCES = [
  'linkedin',
  'referral',
  'job_board',
  'company_site',
  'recruiter',
  'other',
] as const;
export type Source = (typeof SOURCES)[number];

export const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const EVENT_TYPES = ['created', 'status', 'note', 'call', 'email', 'task'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface Application {
  id: string;
  company: string;
  position: string;
  status: Status;
  source: Source;
  priority: Priority;
  location: string | null;
  workMode: WorkMode;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string;
  url: string | null;
  notes: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppEvent {
  id: string;
  applicationId: string;
  type: EventType;
  message: string;
  createdAt: string;
}

export interface ApplicationWithEvents extends Application {
  events: AppEvent[];
}

export interface AnalyticsOverview {
  totals: {
    total: number;
    active: number;
    offers: number;
    responseRate: number;
    offerRate: number;
    medianSalary: number | null;
  };
  byStatus: { status: Status; count: number }[];
  bySource: { source: Source; count: number; offers: number }[];
  weekly: { week: string; label: string; applied: number }[];
  recentEvents: (AppEvent & { company: string; position: string })[];
}
