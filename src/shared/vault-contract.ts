import { z } from 'zod';

export const emptyVaultRequestSchema = z.object({}).strict();

export const createVaultRequestSchema = z
  .object({
    password: z.string().min(12).max(1024),
  })
  .strict();

export const openVaultRequestSchema = z
  .object({
    password: z.string().min(1).max(1024),
  })
  .strict();

export const vaultStateSchema = z
  .object({
    status: z.enum(['locked', 'unlocked']),
    name: z.string().min(1).nullable(),
  })
  .strict();

export const vaultEntrySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    status: z.enum(['locked', 'unlocked']),
  })
  .strict();

export const vaultsStateSchema = z
  .object({
    vaults: z.array(vaultEntrySchema).max(16),
    activeId: z.string().uuid().nullable(),
  })
  .strict();

export const vaultIdRequestSchema = z.object({ id: z.string().uuid() }).strict();

export const unlockVaultRequestSchema = z
  .object({ id: z.string().uuid(), password: z.string().min(1).max(1024) })
  .strict();

export type VaultState = z.infer<typeof vaultStateSchema>;
export type VaultEntry = z.infer<typeof vaultEntrySchema>;
export type VaultsState = z.infer<typeof vaultsStateSchema>;
