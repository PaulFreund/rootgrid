import { z } from 'zod'

const ListenSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535)
})

const RunnerUpgradeSchema = z.object({
  enabled: z.boolean().default(true),
  keepReleases: z.number().int().min(1).max(50).default(3)
}).default({
  enabled: true,
  keepReleases: 3
})

const RunnerSchema = z.object({
  enabled: z.boolean(),
  machineId: z.string().min(1),
  machineName: z.string().min(1),
  upgrade: RunnerUpgradeSchema
})

const HostSelfUpdateSchema = z.object({
  enabled: z.boolean().default(false),
  repo: z.string().min(1).nullable().optional(),
  repoUrl: z.string().min(1).nullable().optional(),
  branch: z.string().min(1).default('main'),
  accessToken: z.string().min(1).nullable().optional(),
  token: z.string().min(1).nullable().optional(),
  assetName: z.string().min(1).default('rootgrid-managed-release.tgz'),
  keepReleases: z.number().int().min(1).max(50).default(3),
  restartCommand: z.string().min(1).nullable().default(null),
  workdir: z.string().min(1).nullable().optional(),
  installCommand: z.string().min(1).optional(),
  buildCommand: z.string().min(1).optional()
}).transform((value) => ({
  enabled: value.enabled === true,
  repo: value.repo ?? value.repoUrl ?? null,
  branch: value.branch,
  accessToken: value.accessToken ?? value.token ?? null,
  assetName: value.assetName,
  keepReleases: value.keepReleases,
  restartCommand: value.restartCommand ?? null
})).default({
  enabled: false,
  repo: null,
  branch: 'main',
  accessToken: null,
  assetName: 'rootgrid-managed-release.tgz',
  keepReleases: 3,
  restartCommand: null
})

export const RootgridConfigSchema = z.object({
  version: z.number().int().min(1),
  retentionDays: z.number().int().min(1).default(30),
  notifications: z.object({
    sseToasts: z.enum(['always', 'never', 'if-not-visible']).default('if-not-visible'),
    webPush: z.enum(['always', 'never', 'if-not-visible']).default('if-not-visible')
  }).default({ sseToasts: 'if-not-visible', webPush: 'if-not-visible' }),
  debug: z.object({
    codexRawCapture: z.object({
      enabled: z.boolean().default(false),
      dir: z.string().min(1).nullable().default(null)
    }).default({ enabled: false, dir: null })
  }).default({ codexRawCapture: { enabled: false, dir: null } }),
  autostart: z.object({
    enabled: z.boolean(),
    method: z.enum(['systemd-user', 'launchd-user']).nullable()
  }),
  runner: RunnerSchema,
  host: z.object({
    enabled: z.boolean(),
    listen: ListenSchema,
    publicUrl: z.string().url().nullable(),
    trustProxy: z.boolean(),
    selfUpdate: HostSelfUpdateSchema,
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
