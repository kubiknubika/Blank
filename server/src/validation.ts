import { z } from 'zod';
import { EVENT_TYPES, PRIORITIES, SOURCES, STATUSES, WORK_MODES } from './types.js';

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
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' })
  .refine(
    (data) => data.salaryMin == null || data.salaryMax == null || data.salaryMin <= data.salaryMax,
    { message: 'salaryMin must not exceed salaryMax', path: ['salaryMin'] },
  );

export const createEventSchema = z.object({
  type: z.enum(EVENT_TYPES).refine((t) => t !== 'created' && t !== 'status', {
    message: 'System event types cannot be created manually',
  }),
  message: z.string().trim().min(1, 'Message is required').max(2000),
});

export const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
