import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildExternalBaseUrl,
  buildRunnerInstallScript,
  createRunnerInstallManager
} from '../src/server/runnerInstallManager.js'

test('buildExternalBaseUrl prefers configured publicUrl and strips trailing slash', () => {
  const req = {
    headers: { host: '127.0.0.1:7337' },
    socket: { encrypted: false }
  }
  assert.equal(buildExternalBaseUrl(req, {
    publicUrl: 'https://rootgrid.example.test/base///',
    trustProxy: true
  }), 'https://rootgrid.example.test/base')
})

test('buildExternalBaseUrl uses forwarded headers only when trustProxy is enabled', () => {
  const req = {
    headers: {
      host: '127.0.0.1:7337',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'rootgrid.example.test'
    },
    socket: { encrypted: false }
  }

  assert.equal(buildExternalBaseUrl(req, { trustProxy: false }), 'http://127.0.0.1:7337')
  assert.equal(buildExternalBaseUrl(req, { trustProxy: true }), 'https://rootgrid.example.test')
})

test('buildRunnerInstallScript generates a self-contained bootstrap script', () => {
  const script = buildRunnerInstallScript({
    baseUrl: 'https://rootgrid.example.test',
    installToken: 'install-token-123',
    runnerToken: 'runner-token-1234567890',
    version: '0.0.1',
    releaseId: 'rootgrid-0.0.1-test',
    configVersion: 1
  })

  assert.match(script, /curl -fsSL "\$ROOTGRID_BUNDLE_URL" -o "\$ARCHIVE_PATH"/)
  assert.match(script, /install-service/)
  assert.match(script, /runnerToken/)
  assert.match(script, /https:\/\/rootgrid\.example\.test\/api\/install\/runner-bundle\?installToken=install-token-123/)
  assert.match(script, /ROOTGRID_FORCE=1/)
  assert.doesNotMatch(script, /need_cmd git/)
  assert.match(script, /ROOTGRID_RUNTIME_DIR/)
  assert.match(script, /ROOTGRID_INSTALL_DIR/)
  assert.match(script, /Install managed Codex now into Rootgrid runtime\?/)
  assert.match(script, /Install managed code-server now into Rootgrid runtime\?/)
  assert.match(script, /Continue runner install without managed Codex\?/)
  assert.match(script, /Continue runner install without managed code-server\?/)
  assert.match(script, /ROOTGRID_CODEX_PREFIX/)
  assert.match(script, /rootgrid_install_system_bubblewrap/)
  assert.match(script, /apt-get install -y bubblewrap/)
  assert.match(script, /if \[ -x "\$ROOTGRID_CODEX_BIN" \]; then\s+rootgrid_install_system_bubblewrap\s+fi/)
  assert.doesNotMatch(script, /@openai\/codex && rootgrid_install_system_bubblewrap/)
  assert.match(script, /ROOTGRID_CODE_SERVER_HOME/)
  assert.match(script, /sh -s -- --method=standalone/)
  assert.match(script, /prompt_yes_no "\$continue_question" 0[\s\S]+return 0/)
  assert.match(script, /Installing Rootgrid runner .* into \$ROOTGRID_RUNTIME_DIR/)
})

test('runner install manager creates expiring bootstrap payloads', async () => {
  let now = 1_000
  let getBundleCalls = 0
  const manager = createRunnerInstallManager({
    config: {
      version: 1,
      host: {
        publicUrl: 'https://rootgrid.example.test',
        trustProxy: false,
        auth: {
          runnerToken: 'runner-token-abcdefghijklmnopqrstuvwxyz'
        }
      }
    },
    releaseBundles: {
      getBundleMetadata() {
        return {
          version: '0.0.1',
          releaseId: null
        }
      },
      async getBundle() {
        getBundleCalls += 1
        return {
          version: '0.0.1',
          releaseId: 'rootgrid-0.0.1-test',
          bundlePath: '/tmp/rootgrid.tgz',
          filename: 'rootgrid.tgz',
          sizeBytes: 123
        }
      }
    },
    ttlMs: 5_000,
    now: () => now
  })

  const req = {
    headers: { host: 'ignored.invalid' },
    socket: { encrypted: true }
  }

  const payload = await manager.createBootstrap(req)
  assert.match(payload.installUrl, /^https:\/\/rootgrid\.example\.test\/api\/install\/runner\.sh\?installToken=/)
  assert.match(payload.installCommand, /^curl -fsSL '/)
  assert.equal(payload.version, '0.0.1')
  assert.equal(payload.releaseId, 'rootgrid-0.0.1-test')
  assert.equal(getBundleCalls, 1)

  const script = await manager.renderInstallScript(req, payload.installToken)
  assert.match(script, /Rootgrid runner installed\./)
  assert.equal(getBundleCalls, 1)

  now += 61_000
  assert.equal(await manager.renderInstallScript(req, payload.installToken), null)
  assert.equal(await manager.getBundleForToken(payload.installToken), null)
})
