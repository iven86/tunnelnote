import { z } from 'zod';

export const sshHostAuthSchema = z.enum(['password', 'privateKey', 'agent', 'keyboardInteractive']);

export const hostOsSchema = z.enum([
  'linux',
  'ubuntu',
  'debian',
  'fedora',
  'arch',
  'raspberrypi',
  'centos',
  'redhat',
  'opensuse',
  'alpine',
  'mint',
  'kali',
  'windows',
  'macos',
  'freebsd',
  'other',
]);

export const hostTagsSchema = z.array(z.string().trim().min(1).max(32)).max(12);
export const hostGroupSchema = z.string().trim().max(200);
export const hostNotesSchema = z.string().max(8000);

export const sshHostSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().trim().min(1).max(128),
    authMethod: sshHostAuthSchema,
    jumpHostId: z.string().uuid().optional(),
    os: hostOsSchema.optional(),
    tags: hostTagsSchema.optional(),
    group: hostGroupSchema.optional(),
    notes: hostNotesSchema.optional(),
    vaultId: z.string().uuid().optional(),
  })
  .strict();

export const sshHostSummariesSchema = z.array(sshHostSummarySchema).max(10_000);

export const emptySshRequestSchema = z.object({}).strict();

export const upsertSshHostRequestSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().trim().min(1).max(128),
    authMethod: sshHostAuthSchema,
    jumpHostId: z.string().uuid().optional(),
    os: hostOsSchema.optional(),
    tags: hostTagsSchema.optional(),
    group: hostGroupSchema.optional(),
    notes: hostNotesSchema.optional(),
    vaultId: z.string().uuid().optional(),
    password: z.string().min(1).max(4096).optional(),
    privateKey: z
      .string()
      .min(1)
      .max(128 * 1024)
      .optional(),
    passphrase: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .superRefine((host, context) => {
    if (host.id && host.jumpHostId === host.id) {
      context.addIssue({
        code: 'custom',
        path: ['jumpHostId'],
        message: 'A host cannot use itself as its jump host.',
      });
    }
    if (host.authMethod === 'password' && host.password === undefined && host.id === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'A password is required when creating a password-authenticated host.',
      });
    }
    if (
      host.authMethod === 'privateKey' &&
      host.privateKey === undefined &&
      host.id === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['privateKey'],
        message: 'A private key is required when creating a key-authenticated host.',
      });
    }
    const hasPassword = host.password !== undefined;
    const hasPrivateKey = host.privateKey !== undefined || host.passphrase !== undefined;
    if (
      (host.authMethod === 'password' && hasPrivateKey) ||
      (host.authMethod === 'privateKey' && hasPassword) ||
      ((host.authMethod === 'agent' || host.authMethod === 'keyboardInteractive') &&
        (hasPassword || hasPrivateKey))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['authMethod'],
        message: 'Credential fields must match the selected authentication method.',
      });
    }
  });

export const hostIdRequestSchema = z.object({ id: z.string().uuid() }).strict();

export const startSshRequestSchema = z
  .object({
    hostId: z.string().uuid(),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(300),
  })
  .strict();

export const sshSessionIdRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();

export const sshInputRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    data: z.string().max(16_384),
  })
  .strict();

export const sshResizeRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(300),
  })
  .strict();

export const approveHostKeyRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    decisionId: z.string().uuid(),
    approve: z.boolean(),
    replaceExisting: z.boolean(),
  })
  .strict();

export const keyboardInteractiveReplySchema = z
  .object({
    sessionId: z.string().uuid(),
    challengeId: z.string().uuid(),
    responses: z.array(z.string().max(4096)).max(12),
  })
  .strict();

export const sftpSessionRequestSchema = z.object({ sessionId: z.string().uuid() }).strict();
export const sftpLocalRootResponseSchema = z
  .object({
    rootId: z.string().uuid(),
    displayName: z.string().min(1).max(255),
  })
  .strict();
export const sftpLocalListRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    rootId: z.string().uuid(),
    relativePath: z.string().max(4096),
  })
  .strict();
export const sftpRemoteListRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    path: z.string().min(1).max(4096),
  })
  .strict();
export const sftpDirectoryEntrySchema = z
  .object({
    name: z.string().min(1).max(255),
    type: z.enum(['directory', 'file', 'symlink', 'other']),
    size: z.number().nonnegative(),
    modifiedAt: z.number().nonnegative(),
  })
  .strict();
export const sftpDirectoryListingSchema = z
  .object({
    path: z.string().max(4096),
    entries: z.array(sftpDirectoryEntrySchema).max(2000),
  })
  .strict();
export const sftpTransferRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    rootId: z.string().uuid(),
    direction: z.enum(['upload', 'download']),
    localPath: z.string().min(1).max(4096),
    remotePath: z.string().min(1).max(4096),
    overwrite: z.boolean(),
    resume: z.boolean(),
  })
  .strict();
export const sftpTransferStartResponseSchema = z.object({ transferId: z.string().uuid() }).strict();
export const sftpTransferCancelRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    transferId: z.string().uuid(),
  })
  .strict();
export const sftpTransferEventSchema = z
  .object({
    type: z.literal('transfer'),
    sessionId: z.string().uuid(),
    transferId: z.string().uuid(),
    direction: z.enum(['upload', 'download']),
    status: z.enum(['queued', 'transferring', 'completed', 'cancelled', 'failed']),
    transferredBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    message: z.string().max(256).optional(),
  })
  .strict();
export const sftpEditReadRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    remotePath: z.string().min(1).max(4096),
  })
  .strict();
export const sftpEditReadResponseSchema = z
  .object({
    remotePath: z.string().max(4096),
    text: z.string().max(1_048_576),
    revision: z.string().regex(/^[A-Fa-f0-9]{64}$/),
  })
  .strict();
export const sftpEditWriteResponseSchema = z
  .object({ revision: z.string().regex(/^[A-Fa-f0-9]{64}$/) })
  .strict();
export const sftpEditWriteRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    remotePath: z.string().min(1).max(4096),
    text: z.string().max(1_048_576),
    expectedRevision: z.string().regex(/^[A-Fa-f0-9]{64}$/),
  })
  .strict();

export const sshSessionEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('state'),
      sessionId: z.string().uuid(),
      hostId: z.string().uuid(),
      state: z.enum(['connecting', 'connected', 'disconnected']),
      message: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('output'),
      sessionId: z.string().uuid(),
      data: z.string().max(65_536),
    })
    .strict(),
  z
    .object({
      type: z.literal('host-key'),
      sessionId: z.string().uuid(),
      decisionId: z.string().uuid(),
      hostname: z.string().max(253),
      port: z.number().int().min(1).max(65535),
      fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
      randomart: z.string().max(500),
      previousFingerprint: z
        .string()
        .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
        .nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('keyboard-interactive'),
      sessionId: z.string().uuid(),
      challengeId: z.string().uuid(),
      name: z.string().max(256),
      instructions: z.string().max(1024),
      hostname: z.string().max(253),
      port: z.number().int().min(1).max(65535),
      prompts: z
        .array(z.object({ text: z.string().max(1024), echo: z.boolean() }).strict())
        .max(12),
    })
    .strict(),
]);
export const sftpEventSchema = sftpTransferEventSchema;

export const sshSessionIdSchema = z.object({ sessionId: z.string().uuid() }).strict();
export const sshSessionStartResponseSchema = sshSessionIdSchema;

export type HostOs = z.infer<typeof hostOsSchema>;
export type SshHostSummary = z.infer<typeof sshHostSummarySchema>;
export type UpsertSshHostRequest = z.infer<typeof upsertSshHostRequestSchema>;
export type SshSessionEvent = z.infer<typeof sshSessionEventSchema>;
export type SftpTransferEvent = z.infer<typeof sftpTransferEventSchema>;
export type SftpDirectoryEntry = z.infer<typeof sftpDirectoryEntrySchema>;
export type SftpEvent = z.infer<typeof sftpEventSchema>;
