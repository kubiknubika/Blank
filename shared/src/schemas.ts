/**
 * Zod schemas shared by server (runtime validation) and client (form types).
 * Keeping them in one place means the contract cannot drift between the two.
 */
import { z } from 'zod';
import { PRIORITIES, SOURCES, STATUSES, USER_EVENT_TYPES, WORK_MODES } from './types.js';

const emptyToNull = (v: unknown) => (v === '' ? null : v);

export const createApplicationSchema = z
  .object({
    company: z.string().trim().min(1, 'Company is required').max(120),
    position: z.string().trim().min(1, 'Position is required').max(160),
    status: z.enum(STATUSES).default('wishlist'),
    source: z.enum(SOURCES).default('other'),
    priority: z.enum(PRIORITIES).default('medium'),
    location: z.preprocess(emptyToNull, z.string().trim().max(120).nullable()).default(null),
    workMode: z.enum(WORK_MODES).default('remote'),
    salaryMin: z.number().int().min(0).max(10_000_000).nullable().optional().default(null),
    salaryMax: z.number().int().min(0).max(10_000_000).nullable().optional().default(null),
    currency: z.string().trim().length(3).default('EUR'),
    url: z
      .preprocess(emptyToNull, z.string().trim().url('Must be a valid URL').max(500).nullable())
      .default(null),
    notes: z.preprocess(emptyToNull, z.string().trim().max(5000).nullable()).default(null),
    appliedAt: z
      .preprocess(
        emptyToNull,
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
          .nullable(),
      )
      .default(null),
    followUpAt: z
      .preprocess(
        emptyToNull,
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
          .nullable(),
      )
      .default(null),
  })
  .refine(
    (data) => data.salaryMin == null || data.salaryMax == null || data.salaryMin <= data.salaryMax,
    { message: 'salaryMin must not exceed salaryMax', path: ['salaryMin'] },
  );

export const updateApplicationSchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    position: z.string().trim().min(1).max(160),
    status: z.enum(STATUSES),
    source: z.enum(SOURCES),
    priority: z.enum(PRIORITIES),
    location: z.preprocess(emptyToNull, z.string().trim().max(120).nullable()),
    workMode: z.enum(WORK_MODES),
    salaryMin: z.number().int().min(0).max(10_000_000).nullable(),
    salaryMax: z.number().int().min(0).max(10_000_000).nullable(),
    currency: z.string().trim().length(3),
    url: z.preprocess(
      emptyToNull,
      z.string().trim().url('Must be a valid URL').max(500).nullable(),
    ),
    notes: z.preprocess(emptyToNull, z.string().trim().max(5000).nullable()),
    appliedAt: z.preprocess(
      emptyToNull,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
        .nullable(),
    ),
    followUpAt: z.preprocess(
      emptyToNull,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
        .nullable(),
    ),
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' })
  .refine(
    (data) => data.salaryMin == null || data.salaryMax == null || data.salaryMin <= data.salaryMax,
    { message: 'salaryMin must not exceed salaryMax', path: ['salaryMin'] },
  );

export const createEventSchema = z.object({
  type: z.enum(USER_EVENT_TYPES),
  message: z.string().trim().min(1, 'Message is required').max(2000),
});

export const listApplicationsQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  // 'true' = only archived rows; omitted/'false' = the active board.
  archived: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * CSV import travels as JSON ({ csv: "..." }) — the file is read in the
 * browser and posted like any other mutation, so the JSON-only CSRF
 * defense applies unchanged. 256 KiB ≈ the express.json body cap.
 */
export const importCsvSchema = z.object({
  csv: z
    .string()
    .min(1, 'CSV content is required')
    .max(256 * 1024),
});
export type ImportCsvInput = z.infer<typeof importCsvSchema>;

// --- auth -----------------------------------------------------------------

const emailSchema = z.string().trim().toLowerCase().min(3).max(254).email();

export const registerSchema = z.object({
  email: emailSchema,
  // NIST-ish: length floor, generous ceiling, no composition rules.
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;
