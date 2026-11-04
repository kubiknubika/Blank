import type {
  AnalyticsOverview,
  Application,
  ApplicationWithEvents,
  AppEvent,
  EventType,
  Status,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, body?.details);
  }
  return body as T;
}

export type ApplicationInput = Omit<Application, 'id' | 'createdAt' | 'updatedAt'>;

export const api = {
  listApplications: (params: { status?: Status; q?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.q) search.set('q', params.q);
    const qs = search.toString();
    return request<Application[]>(`/applications${qs ? `?${qs}` : ''}`);
  },
  getApplication: (id: string) => request<ApplicationWithEvents>(`/applications/${id}`),
  createApplication: (input: Partial<ApplicationInput>) =>
    request<ApplicationWithEvents>('/applications', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateApplication: (id: string, input: Partial<ApplicationInput>) =>
    request<ApplicationWithEvents>(`/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteApplication: (id: string) => request<void>(`/applications/${id}`, { method: 'DELETE' }),
  addEvent: (id: string, type: EventType, message: string) =>
    request<AppEvent>(`/applications/${id}/events`, {
      method: 'POST',
      body: JSON.stringify({ type, message }),
    }),
  overview: () => request<AnalyticsOverview>('/analytics/overview'),
  resetDemo: () =>
    request<{ status: string; applications: number }>('/demo/reset', { method: 'POST' }),
};
