import type {
  AnalyticsOverview,
  ApiErrorBody,
  Application,
  ApplicationWithEvents,
  AppEvent,
  ErrorCode,
  EventType,
  Status,
} from './types';

/**
 * Typed API client. Errors preserve the server's machine-readable code
 * and the request id, so failures are traceable end-to-end.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: ErrorCode,
    public details?: { path: string; message: string }[],
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function requestRaw(path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok && res.status !== 204) {
    const body = (await res.json().catch(() => null)) as Partial<ApiErrorBody> | null;
    const err = body ?? {};
    throw new ApiError(
      err.error ?? `Request failed (${res.status})`,
      res.status,
      err.code,
      err.details,
      err.requestId ?? res.headers.get('x-request-id') ?? undefined,
    );
  }
  return res;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await requestRaw(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type ApplicationInput = Omit<Application, 'id' | 'createdAt' | 'updatedAt'>;

export const api = {
  listApplications: (
    params: { status?: Status; q?: string; limit?: number; offset?: number } = {},
  ) => {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.q) search.set('q', params.q);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.offset !== undefined) search.set('offset', String(params.offset));
    const qs = search.toString();
    return request<Application[]>(`/applications${qs ? `?${qs}` : ''}`);
  },
  /**
   * Fetches EVERY application matching the filter, following X-Total-Count
   * page by page. The server caps a page at 500 and defaults to 100 — a
   * single unpaginated call would silently truncate the board once the
   * tracker grows past the default. The page cap bounds worst-case work.
   */
  listAllApplications: async (
    params: { status?: Status; q?: string } = {},
  ): Promise<Application[]> => {
    const PAGE = 500;
    const MAX_PAGES = 20; // 10k applications is far beyond personal use
    const all: Application[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const search = new URLSearchParams();
      if (params.status) search.set('status', params.status);
      if (params.q) search.set('q', params.q);
      search.set('limit', String(PAGE));
      search.set('offset', String(page * PAGE));
      const res = await requestRaw(`/applications?${search.toString()}`);
      const items = (await res.json()) as Application[];
      all.push(...items);
      const total = Number(res.headers.get('x-total-count'));
      if (items.length < PAGE || (Number.isFinite(total) && all.length >= total)) break;
    }
    return all;
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
