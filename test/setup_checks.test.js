import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { checkCodeServerInstalled } from '../src/setup/setupChecks.js'
import { getManagedCodeServerBinPath } from '../src/lib/runnerTooling.js'

async function withExecutableScript(body, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rootgrid-setup-checks-'))
  const scriptPath = getManagedCodeServerBinPath({ runtimeDir: dir })
  try {
    await mkdir(join(dir, 'tools', 'code-server', 'home', '.local', 'bin'), { recursive: true })
    await writeFile(scriptPath, body, 'utf8')
    await chmod(scriptPath, 0o755)
    return await fn({ dir, scriptPath })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('checkCodeServerInstalled honors env and accepts version output from the managed binary', async () => {
  await withExecutableScript(`#!/bin/sh
if [ "$ROOTGRID_EXPECTED_ENV" != "ready" ]; then
  echo "missing expected env" >&2
  exit 2
fi
printf '4.99.0\\ncommit-abc123\\n'
exit 1
`, async ({ dir, scriptPath }) => {
    const result = await checkCodeServerInstalled({
      allowExternal: false,
      env: {
        HOME: dir,
        PATH: '',
        ROOTGRID_CODE_SERVER_BIN: scriptPath,
        ROOTGRID_EXPECTED_ENV: 'ready',
        ROOTGRID_RUNTIME_DIR: dir
      },
      timeoutMs: 1_500
    })

    assert.equal(result.ok, true)
    assert.equal(result.version, '4.99.0')
    assert.equal(result.command, scriptPath)
    assert.equal(result.source, 'managed')
  })
})

test('checkCodeServerInstalled keeps a broken managed binary uninstalled when no version is reported', async () => {
  await withExecutableScript(`#!/bin/sh
echo "failed to launch code-server" >&2
exit 1
`, async ({ dir, scriptPath }) => {
    const result = await checkCodeServerInstalled({
      allowExternal: false,
      env: {
        HOME: dir,
        PATH: '',
        ROOTGRID_CODE_SERVER_BIN: scriptPath,
        ROOTGRID_RUNTIME_DIR: dir
      },
      timeoutMs: 1_500
    })

    assert.equal(result.ok, false)
    assert.equal(result.version, null)
    assert.equal(result.command, scriptPath)
    assert.equal(result.source, 'managed')
  })
})
