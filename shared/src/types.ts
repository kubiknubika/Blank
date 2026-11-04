/**
 * Domain types — the single source of truth for both client and server.
 * If a shape changes here, both sides fail to compile until they agree.
 */

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

/** Event types the API accepts from users; the rest are system-generated. */
export const USER_EVENT_TYPES = ['note', 'call', 'email', 'task'] as const;
export type UserEventType = (typeof USER_EVENT_TYPES)[number];

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
  /** Monotonic row version for optimistic concurrency (ETag / If-Match). */
  version: number;
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

/** Stable machine-readable error codes returned by the API. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'INVALID_JSON',
  'FORBIDDEN',
  'UNSUPPORTED_MEDIA_TYPE',
  'PRECONDITION_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: string;
  code: ErrorCode;
  requestId?: string;
  details?: { path: string; message: string }[];
}
