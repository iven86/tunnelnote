import { z } from 'zod';

export const getAppInfoRequestSchema = z.object({}).strict();

export const appInfoSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

export type AppInfo = z.infer<typeof appInfoSchema>;
