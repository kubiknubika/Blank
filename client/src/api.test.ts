import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, NetworkError } from './api';
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
    followUpAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
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

describe('api auth methods', () => {
  const user = {
    id: 'u1',
    email: 'alice@example.com',
    displayName: 'Alice',
    isDemo: false,
  };
  const session = { user, expiresAt: '2026-11-11T00:00:00.000Z' };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('me() returns the user on 200 and null on 401', async () => {
    fetchMock.mockResolvedValueOnce(json({ user }));
    expect(await api.me()).toEqual(user);
    fetchMock.mockResolvedValueOnce(
      json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, 401),
    );
    expect(await api.me()).toBeNull();
  });

  it('me() rethrows non-401 failures (network down ≠ signed out)', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'boom', code: 'INTERNAL' }, 500));
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
  });

  it('login/register/demo/logout hit the right endpoints with JSON bodies', async () => {
    fetchMock.mockResolvedValueOnce(json(session));
    await api.login({ email: 'alice@example.com', password: 'pw-long-enough' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/login');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');

    fetchMock.mockResolvedValueOnce(json(session, 201));
    await api.register({ email: 'alice@example.com', password: 'pw-long-enough' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/register');

    fetchMock.mockResolvedValueOnce(json({ ...session, user: { ...user, isDemo: true } }));
    const demo = await api.demo();
    expect(fetchMock.mock.calls[2][0]).toBe('/api/auth/demo');
    expect(demo.user.isDemo).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.logout();
    expect(fetchMock.mock.calls[3][0]).toBe('/api/auth/logout');
  });

  it('a 401 from a DATA endpoint dispatches the unauthorized event; auth endpoints do not', async () => {
    const events: string[] = [];
    const listener = () => events.push('unauthorized');
    // Minimal window shim: this suite runs in the node environment.
    vi.stubGlobal('window', {
      dispatchEvent: (e: { type: string }) => {
        if (e.type === 'offerflow:unauthorized') listener();
        return true;
      },
    });
    try {
      fetchMock.mockResolvedValueOnce(
        json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, 401),
      );
      await expect(api.listApplications()).rejects.toBeInstanceOf(ApiError);
      expect(events).toHaveLength(1);

      // Wrong-password 401 must NOT kick the shell to the login screen.
      fetchMock.mockResolvedValueOnce(
        json({ error: 'Invalid email or password', code: 'UNAUTHORIZED' }, 401),
      );
      await expect(
        api.login({ email: 'alice@example.com', password: 'wrong' }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(events).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('fetch', fetchMock);
    }
  });
});

describe('api network failures (ADR-0017)', () => {
  it('wraps an unreachable server in a friendly NetworkError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const err = await api.listApplications().catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toMatch(/Cannot reach the server/);
  });

  it('does not mask an explicit AbortError', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValueOnce(abort);
    const err = await api.listApplications().catch((e) => e);
    expect(err).toBe(abort);
  });

  it('a server error status is still an ApiError, not a NetworkError', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'nope', code: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const err = await api.listApplications().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(NetworkError);
  });
});
