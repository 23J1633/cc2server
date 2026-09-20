import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { ClaudeSession } from '../lib/claude-session.js'
import { VERSION } from '../index.js'

test('runtime version matches package metadata', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, manifest.version)
})

test('Claude session normalizes metadata and permission presets', () => {
  const session = new ClaudeSession({ cwd: process.cwd(), executable: 'claude', logger: { warn() {}, debug() {} } })
  assert.match(session.sessionId, /^cc-/)
  assert.equal(session.summary().running, false)
  assert.equal(session.setPermissionMode('plan').preset, 'read-only')
  assert.equal(session.setPermissionMode('acceptEdits').preset, 'workspace-write')
  assert.equal(session.setPermissionMode('bypassPermissions').preset, 'full-access')
})

test('Claude session exposes exact model request and reasoning effort', () => {
  const session = new ClaudeSession({
    cwd: process.cwd(), executable: 'claude', model: 'sonnet', reasoningEffort: 'high',
    logger: { warn() {}, debug() {} },
  })
  assert.deepEqual(session.summary().model, {
    provider: 'anthropic', model: 'sonnet', requestedModel: 'sonnet', reasoningEffort: 'high',
  })
  assert.deepEqual(session.setModel('claude-opus-4-8', 'max').selected, {
    provider: 'anthropic', model: 'claude-opus-4-8', requestedModel: 'claude-opus-4-8', reasoningEffort: 'max',
  })
  assert.throws(() => session.setModel('sonnet', 'turbo'), /unsupported effort level/)
})

test('Claude session event window is bounded and ordered', () => {
  const session = new ClaudeSession({ cwd: process.cwd(), executable: 'claude', logger: { warn() {}, debug() {} } })
  for (let i = 0; i < 2100; i += 1) session.emit('unused', i)
  assert.deepEqual(session.history().events, [])
})

test('Claude transport echo replaces neither nor duplicates the submitted user message', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = {
    writable: true,
    write(line) {
      const input = JSON.parse(line)
      if (input.type !== 'user') return
      queueMicrotask(() => {
        child.stdout.emit('data', `${JSON.stringify({ type: 'user', message: input.message })}\n`)
        child.stdout.emit('data', `${JSON.stringify({ type: 'result', result: '', is_error: false })}\n`)
      })
    },
    end() {},
  }
  child.kill = () => true

  const session = new ClaudeSession({
    cwd: process.cwd(),
    executable: 'claude-fixture',
    spawnProcess: () => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    logger: { warn() {}, debug() {} },
  })
  const events = []
  session.on('event', (event) => {
    if (event.kind === 'session/event') events.push(event.data)
  })

  const result = await session.prompt('只出现一次', 'queue', 'client-message-1')
  await new Promise((resolve) => setImmediate(resolve))

  const userEvents = events.filter((event) => event.type === 'user/message')
  assert.equal(userEvents.length, 1)
  assert.equal(userEvents[0].data.clientMessageId, 'client-message-1')
  assert.equal(userEvents[0].data.source.rpcId, 'client-message-1')
  assert.equal(result.clientMessageId, 'client-message-1')
})
