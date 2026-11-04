import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from './api';
import type { Application } from './types';

/**
 * The board must show EVERY application: the server defaults to 100 rows
 * per page, so the client follows X-Total-Count instead of trusting a
 * single response. These tests pin the paging contract.
 */
function makeApp(id: string): Application {
  return {
    id,
    company: `Co ${id}`,
    position: 'FE',
    status: 'applied',
    source: 'other',
    priority: 'medium',
    location: null,
    workMode: 'remote',
    salaryMin: null,
    salaryMax: null,
    currency: 'EUR',
    url: null,
    notes: null,
    appliedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function pageResponse(items: Application[], total: number): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Total-Count': String(total) },
  });
}

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe('api.listAllApplications', () => {
  it('returns a single page when everything fits', async () => {
    fetchMock.mockResolvedValueOnce(pageResponse([makeApp('a'), makeApp('b')], 2));
    const apps = await api.listAllApplications();
    expect(apps).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('limit=500');
  });

  it('follows X-Total-Count across pages and concatenates in order', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => makeApp(`p1-${i}`));
    const page2 = [makeApp('p2-0'), makeApp('p2-1')];
    fetchMock
      .mockResolvedValueOnce(pageResponse(page1, 502))
      .mockResolvedValueOnce(pageResponse(page2, 502));

    const apps = await api.listAllApplications();
    expect(apps).toHaveLength(502);
    expect(apps[500].id).toBe('p2-0');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('offset=500');
  });

  it('stops on a short page even without X-Total-Count', async () => {
    const items = [makeApp('a')];
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(items), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const apps = await api.listAllApplications();
    expect(apps).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes filters through to every page', async () => {
    fetchMock.mockResolvedValueOnce(pageResponse([makeApp('a')], 1));
    await api.listAllApplications({ status: 'offer', q: 'acme' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('status=offer');
    expect(url).toContain('q=acme');
  });

  it('propagates coded API errors from any page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        pageResponse(
          Array.from({ length: 500 }, (_, i) => makeApp(`${i}`)),
          600,
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Boom', code: 'INTERNAL', requestId: 'r-1' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    await expect(api.listAllApplications()).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      code: 'INTERNAL',
      requestId: 'r-1',
    });
  });
});

describe('api error decoding', () => {
  it('keeps validation details and request id on ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'Validation failed',
          code: 'VALIDATION_FAILED',
          requestId: 'r-2',
          details: [{ path: 'company', message: 'Company is required' }],
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const promise = api.createApplication({ company: '' });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await promise.catch((e: ApiError) => {
      expect(e.details?.[0].path).toBe('company');
      expect(e.requestId).toBe('r-2');
    });
  });
});
