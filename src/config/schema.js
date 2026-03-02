import { z } from 'zod'

const ListenSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535)
})

export const RootgridConfigSchema = z.object({
  version: z.number().int().min(1),
  retentionDays: z.number().int().min(1).default(30),
  autostart: z.object({
    enabled: z.boolean(),
    method: z.enum(['systemd-user']).nullable()
  }),
  runner: z.object({
    enabled: z.boolean(),
    machineId: z.string().min(1),
    machineName: z.string().min(1)
  }),
  host: z.object({
    enabled: z.boolean(),
    listen: ListenSchema,
    publicUrl: z.string().url().nullable(),
    trustProxy: z.boolean(),
    auth: z.object({
      clientToken: z.string().min(16),
      runnerToken: z.string().min(16)
    })
  }),
  upstream: z.object({
    enabled: z.boolean(),
    url: z.string().url().nullable(),
    runnerToken: z.string().min(16).nullable()
  })
})
