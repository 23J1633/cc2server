import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureSharedConfig, resolveAgentConfig } from '../lib/a2s/shared-config.js'

test('shared config is created once and reused by every agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a2s-config-'))
  const file = join(dir, 'config.json')
  const first = await ensureSharedConfig(file)
  const second = await ensureSharedConfig(file)
  assert.equal(first.document.device.key, second.document.device.key)
  assert.match(first.document.device.key, /^a2sk_/)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).device.key, first.document.device.key)
  const claude = resolveAgentConfig(first, 'claude')
  const codex = resolveAgentConfig(first, 'codex')
  assert.equal(claude.key, codex.key)
  assert.notEqual(claude.instanceId, codex.instanceId)
  assert.equal(claude.locale, 'system')
  assert.match(claude.resolvedLocale, /^(zh-CN|en-US)$/)
  assert.equal(resolveAgentConfig(first, 'claude', { locale: 'en-US' }).resolvedLocale, 'en-US')
})
