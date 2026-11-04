import { z } from 'zod';
import {
  createApplicationSchema,
  createEventSchema,
  loginSchema,
  registerSchema,
  updateApplicationSchema,
} from '@offerflow/shared/schemas';
import {
  ERROR_CODES,
  EVENT_TYPES,
  PRIORITIES,
  SOURCES,
  STATUSES,
  WORK_MODES,
  type AnalyticsOverview,
  type AppEvent,
  type Application,
  type AuthUser,
} from '@offerflow/shared';

/**
 * The OpenAPI 3.1 contract, built in code — not a hand-maintained YAML
 * file that silently rots.
 *
 * Two anti-drift mechanisms:
 *  1. Request bodies are generated from the SAME zod schemas the server
 *     validates with (zod 4 `z.toJSONSchema`; 3.1 accepts JSON Schema
 *     2020-12 dialects natively).
 *  2. Response models are typed as `Record<keyof T, ...>` against the
 *     shared TypeScript interfaces — adding a field to `Application`
 *     breaks compilation HERE until the contract is updated. A runtime
 *     test additionally compares contract keys with real API responses.
 */

type JsonSchema = Record<string, unknown>;

/** Convert a zod input schema, inlining `z.preprocess` pipes sensibly. */
function inputSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override: (ctx) => {
      const def = (ctx.zodSchema as { _zod?: { def?: { type?: string; out?: z.ZodType } } })._zod
        ?.def;
      // z.preprocess('', → null) is a pipe whose input side is `unknown`.
      // Document the meaningful side: the schema after preprocessing.
      if (def?.type === 'pipe' && def.out) {
        const inner = z.toJSONSchema(def.out, { io: 'input', unrepresentable: 'any' });
        delete (inner as JsonSchema).$schema;
        for (const key of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[key];
        Object.assign(ctx.jsonSchema, inner);
      }
    },
  }) as JsonSchema;
  delete json.$schema;
  return json;
}

const enumOf = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: [...values] });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;

// `satisfies Record<keyof Application, JsonSchema>` = compile-time drift guard.
const applicationFields = {
  id: { ...str, format: 'uuid' },
  company: str,
  position: str,
  status: enumOf(STATUSES),
  source: enumOf(SOURCES),
  priority: enumOf(PRIORITIES),
  location: nullable(str),
  workMode: enumOf(WORK_MODES),
  salaryMin: nullable(int),
  salaryMax: nullable(int),
  currency: str,
  url: nullable({ ...str, format: 'uri' }),
  notes: nullable(str),
  appliedAt: nullable({ ...str, format: 'date' }),
  followUpAt: nullable({ ...str, format: 'date' }),
  createdAt: { ...str, format: 'date-time' },
  updatedAt: { ...str, format: 'date-time' },
  version: { ...int, minimum: 1, description: 'Monotonic row version; mirrors the ETag.' },
} satisfies Record<keyof Application, JsonSchema>;

const eventFields = {
  id: { ...str, format: 'uuid' },
  applicationId: { ...str, format: 'uuid' },
  type: enumOf(EVENT_TYPES),
  message: str,
  createdAt: { ...str, format: 'date-time' },
} satisfies Record<keyof AppEvent, JsonSchema>;

const overviewTotalsFields = {
  total: int,
  active: int,
  offers: int,
  responseRate: { type: 'number' },
  offerRate: { type: 'number' },
  medianSalary: nullable({ type: 'number' }),
} satisfies Record<keyof AnalyticsOverview['totals'], JsonSchema>;

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
});

const rateLimitedResponse = {
  description: 'Rate limit exceeded for this IP. Wait `Retry-After` seconds.',
  headers: {
    'Retry-After': {
      schema: { type: 'integer', minimum: 1 },
      description: 'Seconds until the window resets.',
    },
  },
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
};

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const;

const jsonBody = (ref: string) => ({
  required: true,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});

// Compile-time drift guard for the auth user model, same as Application.
const authUserFields = {
  id: str,
  email: { ...str, format: 'email' },
  displayName: str,
  isDemo: { type: 'boolean' },
} satisfies Record<keyof AuthUser, JsonSchema>;

const sessionResponse = (description: string) => ({
  description,
  headers: {
    'Set-Cookie': {
      schema: str,
      description: 'offerflow_session=<token>; HttpOnly; SameSite=Lax; Path=/ (+Secure on HTTPS).',
    },
  },
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          user: { $ref: '#/components/schemas/AuthUser' },
          expiresAt: { ...str, format: 'date-time' },
        },
        required: ['user', 'expiresAt'],
      },
    },
  },
});

const unauthorizedResponse = errorResponse(
  'No valid session cookie. Sign in via /api/auth/login or /api/auth/demo.',
);

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'OfferFlow API',
      version: '1.0.0',
      description:
        'Job-application tracker API. Data endpoints require a session cookie ' +
        '(POST /api/auth/register, /api/auth/login, or /api/auth/demo) and are ' +
        'scoped to the signed-in user. Mutations are rate-limited per IP. ' +
        'Single-application reads/writes use ETag / If-Match optimistic concurrency.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'auth' },
      { name: 'applications' },
      { name: 'events' },
      { name: 'analytics' },
      { name: 'operations' },
    ],
    paths: {
      '/api/auth/register': {
        post: {
          tags: ['auth'],
          summary: 'Create an account and start a session.',
          requestBody: jsonBody('RegisterInput'),
          responses: {
            201: sessionResponse('Account created; session cookie set.'),
            400: errorResponse('Validation failed.'),
            409: errorResponse('An account with this email already exists.'),
            429: rateLimitedResponse,
          },
        },
      },
      '/api/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'Sign in with email and password.',
          requestBody: jsonBody('LoginInput'),
          responses: {
            200: sessionResponse('Signed in; session cookie set.'),
            400: errorResponse('Validation failed.'),
            401: errorResponse('Invalid email or password (deliberately indistinguishable).'),
            429: rateLimitedResponse,
          },
        },
      },
      '/api/auth/demo': {
        post: {
          tags: ['auth'],
          summary: 'Sign into the shared, public demo account (no credentials).',
          responses: {
            200: sessionResponse('Demo session cookie set.'),
            429: rateLimitedResponse,
          },
        },
      },
      '/api/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'Revoke the current session (idempotent).',
          responses: {
            204: { description: 'Session revoked; cookie cleared.' },
          },
        },
      },
      '/api/auth/me': {
        get: {
          tags: ['auth'],
          summary: 'The signed-in user.',
          security: [{ cookieAuth: [] }],
          responses: {
            200: {
              description: 'Current user.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { user: { $ref: '#/components/schemas/AuthUser' } },
                    required: ['user'],
                  },
                },
              },
            },
            401: unauthorizedResponse,
          },
        },
      },
      '/api/health': {
        get: {
          tags: ['operations'],
          summary: 'Liveness probe (process is up).',
          responses: {
            200: {
              description: 'Alive.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { const: 'ok' }, applications: int },
                    required: ['status', 'applications'],
                  },
                },
              },
            },
          },
        },
      },
      '/api/ready': {
        get: {
          tags: ['operations'],
          summary: 'Readiness probe (accepting traffic; 503 while draining or DB-less).',
          responses: {
            200: {
              description: 'Ready.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { const: 'ready' } },
                    required: ['status'],
                  },
                },
              },
            },
            503: {
              description: 'Draining or database unavailable.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { enum: ['draining', 'unavailable'] } },
                    required: ['status'],
                  },
                },
              },
            },
          },
        },
      },
      '/api/applications': {
        get: {
          tags: ['applications'],
          summary: "List the signed-in user's applications (paginated, filterable).",
          security: [{ cookieAuth: [] }],
          parameters: [
            { name: 'status', in: 'query', schema: enumOf(STATUSES) },
            {
              name: 'q',
              in: 'query',
              description: 'Substring match on company/position/location (literal, LIKE-escaped).',
              schema: { type: 'string', maxLength: 200 },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            200: {
              description: 'A page of applications.',
              headers: {
                'X-Total-Count': {
                  schema: { type: 'integer' },
                  description: 'Total matching rows, ignoring limit/offset.',
                },
              },
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Application' } },
                },
              },
            },
            400: errorResponse('Invalid query parameters.'),
            401: unauthorizedResponse,
          },
        },
        post: {
          tags: ['applications'],
          summary: 'Create an application owned by the signed-in user.',
          security: [{ cookieAuth: [] }],
          requestBody: jsonBody('CreateApplicationInput'),
          responses: {
            201: {
              description: 'Created (includes the initial "created" event).',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ApplicationWithEvents' },
                },
              },
            },
            400: errorResponse('Validation failed.'),
            401: unauthorizedResponse,
            415: errorResponse('Content-Type must be application/json.'),
            429: rateLimitedResponse,
          },
        },
      },
      '/api/applications/{id}': {
        get: {
          tags: ['applications'],
          summary: 'Fetch one application with its event history.',
          security: [{ cookieAuth: [] }],
          parameters: [idParam],
          responses: {
            200: {
              description: 'Found.',
              headers: {
                ETag: {
                  schema: { type: 'string' },
                  description: 'Strong validator: quoted row version, e.g. `"3"`.',
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ApplicationWithEvents' },
                },
              },
            },
            401: unauthorizedResponse,
            404: errorResponse('No such application (or it belongs to another user).'),
          },
        },
        patch: {
          tags: ['applications'],
          summary: 'Partially update an application (optional optimistic concurrency).',
          security: [{ cookieAuth: [] }],
          description:
            'Send `If-Match: "<version>"` to fail with 412 instead of overwriting a concurrent ' +
            'edit; `If-Match: *` requires existence. Without the header the write is ' +
            'last-write-wins (used by drag-and-drop status moves).',
          parameters: [
            idParam,
            {
              name: 'If-Match',
              in: 'header',
              required: false,
              schema: { type: 'string', examples: ['"3"', '*'] },
            },
          ],
          requestBody: jsonBody('UpdateApplicationInput'),
          responses: {
            200: {
              description: 'Updated; version incremented. Includes the full event history.',
              headers: { ETag: { schema: { type: 'string' } } },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ApplicationWithEvents' },
                },
              },
            },
            400: errorResponse('Validation failed or malformed If-Match.'),
            401: unauthorizedResponse,
            404: errorResponse('No such application (or it belongs to another user).'),
            412: errorResponse('Version mismatch — the row changed since it was read.'),
            415: errorResponse('Content-Type must be application/json.'),
            429: rateLimitedResponse,
          },
        },
        delete: {
          tags: ['applications'],
          summary: 'Delete an application and its events.',
          security: [{ cookieAuth: [] }],
          parameters: [idParam],
          responses: {
            204: { description: 'Deleted.' },
            401: unauthorizedResponse,
            404: errorResponse('No such application (or it belongs to another user).'),
            429: rateLimitedResponse,
          },
        },
      },
      '/api/applications/{id}/events': {
        post: {
          tags: ['events'],
          summary: 'Append a user event (note / call / email / task).',
          security: [{ cookieAuth: [] }],
          parameters: [idParam],
          requestBody: jsonBody('CreateEventInput'),
          responses: {
            201: {
              description: 'Event appended.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/AppEvent' } },
              },
            },
            400: errorResponse('Validation failed.'),
            401: unauthorizedResponse,
            404: errorResponse('No such application (or it belongs to another user).'),
            429: rateLimitedResponse,
          },
        },
      },
      '/api/reminders': {
        get: {
          tags: ['applications'],
          summary: 'Applications with a follow-up date, soonest first.',
          description:
            "Flat list; clients bucket into overdue/today/upcoming in the USER's timezone. " +
            'Moving an application to rejected clears its follow-up automatically.',
          security: [{ cookieAuth: [] }],
          responses: {
            200: {
              description: 'Reminders (may be empty).',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Application' } },
                },
              },
            },
            401: unauthorizedResponse,
          },
        },
      },
      '/api/analytics/overview': {
        get: {
          tags: ['analytics'],
          summary: 'Dashboard aggregates for the signed-in user (totals, funnels, weekly, recent).',
          security: [{ cookieAuth: [] }],
          responses: {
            200: {
              description: 'Overview.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/AnalyticsOverview' } },
              },
            },
            401: unauthorizedResponse,
          },
        },
      },
      '/api/demo/reset': {
        post: {
          tags: ['operations'],
          summary: "Replace the DEMO account's data with the seed (demo account only).",
          security: [{ cookieAuth: [] }],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            200: {
              description: 'Reseeded.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { const: 'reseeded' }, applications: int },
                    required: ['status', 'applications'],
                  },
                },
              },
            },
            401: unauthorizedResponse,
            403: errorResponse('Only the shared demo account may reseed.'),
            429: rateLimitedResponse,
          },
        },
      },
      '/api/openapi.json': {
        get: {
          tags: ['operations'],
          summary: 'This contract, as JSON.',
          responses: { 200: { description: 'OpenAPI 3.1 document.' } },
        },
      },
      '/api/metrics': {
        get: {
          tags: ['operations'],
          summary: 'Prometheus scrape endpoint (text exposition format).',
          responses: {
            200: { description: 'Metrics.', content: { 'text/plain': { schema: str } } },
            404: errorResponse('Metrics disabled by configuration.'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'offerflow_session',
          description: 'Opaque session token; only its SHA-256 is stored server-side.',
        },
      },
      schemas: {
        AuthUser: {
          type: 'object',
          properties: authUserFields,
          required: Object.keys(authUserFields),
        },
        RegisterInput: inputSchema(registerSchema),
        LoginInput: inputSchema(loginSchema),
        CreateApplicationInput: inputSchema(createApplicationSchema),
        UpdateApplicationInput: inputSchema(updateApplicationSchema),
        CreateEventInput: inputSchema(createEventSchema),
        Application: {
          type: 'object',
          properties: applicationFields,
          required: Object.keys(applicationFields),
        },
        ApplicationWithEvents: {
          allOf: [
            { $ref: '#/components/schemas/Application' },
            {
              type: 'object',
              properties: {
                events: { type: 'array', items: { $ref: '#/components/schemas/AppEvent' } },
              },
              required: ['events'],
            },
          ],
        },
        AppEvent: { type: 'object', properties: eventFields, required: Object.keys(eventFields) },
        AnalyticsOverview: {
          type: 'object',
          properties: {
            totals: {
              type: 'object',
              properties: overviewTotalsFields,
              required: Object.keys(overviewTotalsFields),
            },
            byStatus: {
              type: 'array',
              items: {
                type: 'object',
                properties: { status: enumOf(STATUSES), count: int },
                required: ['status', 'count'],
              },
            },
            bySource: {
              type: 'array',
              items: {
                type: 'object',
                properties: { source: enumOf(SOURCES), count: int, offers: int },
                required: ['source', 'count', 'offers'],
              },
            },
            weekly: {
              type: 'array',
              items: {
                type: 'object',
                properties: { week: str, label: str, applied: int },
                required: ['week', 'label', 'applied'],
              },
            },
            recentEvents: {
              type: 'array',
              items: {
                allOf: [
                  { $ref: '#/components/schemas/AppEvent' },
                  {
                    type: 'object',
                    properties: { company: str, position: str },
                    required: ['company', 'position'],
                  },
                ],
              },
            },
          },
          required: ['totals', 'byStatus', 'bySource', 'weekly', 'recentEvents'],
        },
        ApiError: {
          type: 'object',
          properties: {
            error: str,
            code: enumOf(ERROR_CODES),
            details: {
              type: 'array',
              items: {
                type: 'object',
                properties: { path: str, message: str },
                required: ['path', 'message'],
              },
            },
            requestId: str,
          },
          required: ['error', 'code'],
        },
      },
    },
  };
}
