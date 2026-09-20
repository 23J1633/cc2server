import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAdapter } from '../lib/claude-adapter.js'
import { loadClaudeHistory, readClaudeHistoryMetadata } from '../lib/claude-history.js'

const logger = { debug() {}, warn() {} }

test('native Claude JSONL history is discoverable and converted to A2S events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc2server-history-'))
  const cwd = join(root, 'workspace')
  const claudeDir = join(root, '.claude')
  const projectDir = join(claudeDir, 'projects', 'fixture-project')
  const transcript = join(projectDir, 'native-session.jsonl')
  await mkdir(cwd)
  await mkdir(projectDir, { recursive: true })
  const records = [
    { type: 'ai-title', aiTitle: 'Recovered conversation', sessionId: 'native-session' },
    { type: 'user', sessionId: 'native-session', uuid: 'u1', promptId: 'p1', cwd, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'remember me' }] } },
    { type: 'assistant', sessionId: 'native-session', uuid: 'a1', cwd, timestamp: '2026-01-01T00:00:01Z', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'thinking', thinking: 'checking' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } }] } },
    { type: 'user', sessionId: 'native-session', uuid: 'u2', cwd, timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' }] } },
    { type: 'assistant', sessionId: 'native-session', uuid: 'a2', cwd, timestamp: '2026-01-01T00:00:03Z', message: { id: 'm2', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'restored' }] } },
    { type: 'user', sessionId: 'native-session', uuid: 'u3', promptId: 'p2', cwd, timestamp: '2026-01-01T00:10:00Z', message: { role: 'user', content: [{ type: 'text', text: 'second turn' }] } },
    { type: 'assistant', sessionId: 'native-session', uuid: 'a3', cwd, timestamp: '2026-01-01T00:10:01Z', message: { id: 'm3', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'again' }] } },
  ]
  await writeFile(transcript, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)

  try {
    const metadata = await readClaudeHistoryMetadata(transcript)
    assert.equal(metadata.title, 'Recovered conversation')
    assert.equal(metadata.cwd, cwd)
    const parsed = await loadClaudeHistory(transcript)
    assert.deepEqual(parsed.events.map((event) => event.type), [
      'turn/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end',
      'turn/start', 'user/message', 'assistant/message', 'turn/end',
    ])
    assert.equal(parsed.events.find((event) => event.type === 'turn/end').time, Date.parse('2026-01-01T00:00:03Z'))

    const adapter = new ClaudeAdapter({
      executable: 'claude',
      defaultCwd: cwd,
      allowedCwdPrefixes: [cwd],
      claudeConfigDir: claudeDir,
    }, { logger, configDir: join(root, 'a2s') })
    await adapter.init()
    const sessions = await adapter.handle('session.list', {})
    const session = sessions.items.find((item) => item.nativeSessionId === 'native-session')
    assert.ok(session)
    assert.equal(session.blank, false)
    assert.equal(session.title, 'Recovered conversation')
    const events = await adapter.handle('session.events', { sessionId: session.sessionId, limit: 100 })
    assert.equal(events.events.find((event) => event.type === 'user/message').data.message.content[0].text, 'remember me')
    assert.equal(events.events.findLast((event) => event.type === 'assistant/message').data.message.content[0].text, 'again')
    await adapter.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('inferred Claude workspaces can be renamed, removed, and re-added', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc2server-workspace-'))
  const cwd = join(root, 'workspace')
  const configDir = join(root, 'a2s')
  await mkdir(cwd)
  const adapter = new ClaudeAdapter({
    executable: 'claude', defaultCwd: cwd, allowedCwdPrefixes: [cwd], claudeConfigDir: join(root, 'empty-claude'),
  }, { logger, configDir })
  try {
    await adapter.init()
    await adapter.handle('session.create', { cwd })
    assert.equal((await adapter.handle('workspace.list', {})).items[0].title, 'workspace')

    await adapter.handle('workspace.rename', { path: cwd, title: 'Renamed workspace' })
    assert.equal((await adapter.handle('workspace.list', {})).items[0].title, 'Renamed workspace')

    await adapter.handle('workspace.remove', { path: cwd })
    assert.equal((await adapter.handle('workspace.list', {})).items[0].hidden, true)

    await adapter.handle('workspace.create', { path: cwd, title: 'Visible again' })
    const visible = (await adapter.handle('workspace.list', {})).items[0]
    assert.equal(visible.hidden, false)
    assert.equal(visible.title, 'Visible again')
    const stored = JSON.parse(await readFile(join(configDir, 'claude-workspaces.json'), 'utf8'))
    assert.equal(stored.items[0].title, 'Visible again')
  } finally {
    await adapter.close()
    await rm(root, { recursive: true, force: true })
  }
})
