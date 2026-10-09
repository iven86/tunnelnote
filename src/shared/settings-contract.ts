import { z } from 'zod';

export const sessionLoggingSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['perSession', 'single']),
    directory: z.string().min(1).max(1024).nullable(),
    stripAnsi: z.boolean(),
  })
  .strict();

export const appSettingsSchema = z
  .object({
    dataDirectory: z.string().min(1).max(1024).nullable(),
    idleLockMinutes: z.number().int().min(1).max(240),
    lockOnMinimize: z.boolean(),
    terminalFontSize: z.number().int().min(8).max(32),
    terminalScrollback: z.number().int().min(500).max(100_000),
    sessionLogging: sessionLoggingSchema,
  })
  .strict();

export const DEFAULT_SETTINGS: AppSettings = {
  dataDirectory: null,
  idleLockMinutes: 5,
  lockOnMinimize: true,
  terminalFontSize: 13,
  terminalScrollback: 5000,
  sessionLogging: { enabled: false, mode: 'perSession', directory: null, stripAnsi: true },
};

export const settingsPathsSchema = z
  .object({
    defaultDataDirectory: z.string(),
    activeDataDirectory: z.string(),
    logsDirectory: z.string(),
    settingsFile: z.string(),
  })
  .strict();

export const settingsStateSchema = z
  .object({ settings: appSettingsSchema, paths: settingsPathsSchema })
  .strict();

export const openFolderRequestSchema = z.object({ kind: z.enum(['data', 'logs']) }).strict();

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type SettingsState = z.infer<typeof settingsStateSchema>;
