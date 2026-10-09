import { z } from 'zod';

const id = z.string().uuid();
const port = z.number().int().min(1).max(65535);
const bindPort = z.number().int().min(0).max(65535);

export const forwardRuleInputSchema = z
  .object({
    id: id.optional(),
    hostId: id,
    label: z.string().trim().min(1).max(120),
    type: z.enum(['local', 'remote', 'dynamic']),
    bindHost: z.string().trim().min(1).max(253).default('127.0.0.1'),
    bindPort,
    destHost: z.string().trim().max(253).optional(),
    destPort: port.optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.type !== 'dynamic' && (!rule.destHost || rule.destPort === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['destHost'],
        message: 'Local and remote forwards need a destination host and port.',
      });
    }
    if (rule.type === 'remote' && rule.bindPort === 0) {
      context.addIssue({ code: 'custom', path: ['bindPort'], message: 'Choose a remote port.' });
    }
  });
export const forwardRuleSchema = forwardRuleInputSchema.safeExtend({ id });
export const forwardRulesSchema = z.array(forwardRuleSchema).max(1000);
export const forwardStatusSchema = z
  .object({
    ruleId: id,
    sessionId: id,
    state: z.enum(['running', 'stopped', 'error']),
    boundPort: z.number().int().min(0).max(65535).optional(),
    message: z.string().max(500).optional(),
  })
  .strict();
export const forwardStatusesSchema = z.array(forwardStatusSchema);
export const forwardStartRequestSchema = z
  .object({ ruleId: id, sessionId: id, confirmPublicBind: z.boolean().default(false) })
  .strict();
export const forwardStopRequestSchema = z.object({ ruleId: id }).strict();

export const snippetInputSchema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(120),
    command: z.string().min(1).max(8192),
    timeoutSeconds: z.number().int().min(1).max(3600).default(30),
  })
  .strict();
export const snippetSchema = snippetInputSchema.safeExtend({ id });
export const snippetsSchema = z.array(snippetSchema).max(2000);

export const connectedSessionSchema = z
  .object({ sessionId: id, hostId: id, hostName: z.string() })
  .strict();
export const connectedSessionsSchema = z.array(connectedSessionSchema);

export const runRequestSchema = z
  .object({
    command: z.string().min(1).max(8192),
    variables: z.record(z.string().max(64), z.string().max(1024)).default({}),
    sessionIds: z.array(id).min(1).max(16),
    timeoutSeconds: z.number().int().min(1).max(3600).default(30),
    recordHistory: z.boolean().default(false),
  })
  .strict();
export const runResultSchema = z
  .object({
    sessionId: id,
    hostName: z.string(),
    command: z.string(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    output: z.string(),
    error: z.string().optional(),
    durationMs: z.number(),
    startedAt: z.string(),
  })
  .strict();
export const runResultsSchema = z.array(runResultSchema);
export const exportRequestSchema = z
  .object({ results: runResultsSchema, format: z.enum(['markdown', 'csv']) })
  .strict();
export const historyQuerySchema = z.object({ query: z.string().max(200).default('') }).strict();
export const historySettingSchema = z.object({ enabled: z.boolean() }).strict();
export const textResponseSchema = z.object({ text: z.string() }).strict();

export const noteHostSchema = z
  .object({
    server: z.string().max(200),
    address: z.string().max(300),
    tags: z.array(z.string().max(60)).max(30),
  })
  .strict();
export const noteSummarySchema = z
  .object({
    /** `<locationId>/<folder>/<name>.md` */
    path: z.string().max(400),
    title: z.string().max(300),
    name: z.string().max(200),
    location: z.string().max(64),
    folder: z.string().max(300),
    host: noteHostSchema.optional(),
    updatedAt: z.string(),
  })
  .strict();
export const noteSummariesSchema = z.array(noteSummarySchema).max(50_000);
export const noteSchema = noteSummarySchema.safeExtend({
  body: z.string(),
  backlinks: z.array(z.string()),
  secretWarnings: z.array(z.string()),
});
export const noteSaveRequestSchema = z
  .object({
    location: z.string().min(1).max(64),
    folder: z.string().max(300),
    name: z.string().min(1).max(120),
    body: z.string().max(2 * 1024 * 1024),
    host: noteHostSchema.optional(),
    previousPath: z.string().max(400).optional(),
  })
  .strict();
export const notePathRequestSchema = z.object({ path: z.string().min(1).max(400) }).strict();
export const noteSearchRequestSchema = z.object({ query: z.string().max(200) }).strict();
export const noteSearchResultsSchema = z.array(
  z.object({ path: z.string(), title: z.string(), snippet: z.string() }).strict(),
);
export const noteLocationSchema = z
  .object({
    id: z.string().max(64),
    name: z.string().max(300),
    path: z.string().max(2000),
    builtin: z.boolean(),
    available: z.boolean(),
    folders: z.array(z.string().max(300)),
  })
  .strict();
export const noteLocationsSchema = z.array(noteLocationSchema);
export const noteLocationIdSchema = z.object({ id: z.string().min(1).max(64) }).strict();
export const noteCreateFolderSchema = z
  .object({ location: z.string().min(1).max(64), name: z.string().min(1).max(200) })
  .strict();
export const savedSchema = z.object({ saved: z.boolean() }).strict();

export type ForwardRule = z.infer<typeof forwardRuleSchema>;
export type ForwardRuleInput = z.input<typeof forwardRuleInputSchema>;
export type ForwardStatus = z.infer<typeof forwardStatusSchema>;
export type Snippet = z.infer<typeof snippetSchema>;
export type SnippetInput = z.input<typeof snippetInputSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type RunRequest = z.input<typeof runRequestSchema>;
export type NoteSummary = z.infer<typeof noteSummarySchema>;
export type Note = z.infer<typeof noteSchema>;
export type NoteLocation = z.infer<typeof noteLocationSchema>;
export type NoteHost = z.infer<typeof noteHostSchema>;
export type NoteSaveRequest = z.input<typeof noteSaveRequestSchema>;
