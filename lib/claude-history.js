import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, extname, join, resolve } from 'node:path'

const METADATA_PREFIX_BYTES = 512 * 1024
const MAX_IMPORTED_EVENTS = 20_000

/**
 * Discover Claude Code's native JSONL transcripts without loading complete
 * conversations during bridge startup. Histories are parsed lazily when the
 * corresponding session is opened in the server UI.
 */
export async function discoverClaudeHistories(configDir, { allowedRoots = [] } = {}) {
  const projectsDir = join(configDir, 'projects')
  const projectEntries = await readdir(projectsDir, { withFileTypes: true }).catch(() => [])
  const histories = []

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue
    const projectDir = join(projectsDir, projectEntry.name)
    const files = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
    for (const file of files) {
      if (!file.isFile() || extname(file.name).toLowerCase() !== '.jsonl') continue
      const path = join(projectDir, file.name)
      const metadata = await readClaudeHistoryMetadata(path).catch(() => null)
      if (!metadata?.sessionId || !metadata.cwd) continue
      if (allowedRoots.length && !pathAllowed(metadata.cwd, allowedRoots)) continue
      histories.push(metadata)
    }
  }

  return histories.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function readClaudeHistoryMetadata(path) {
  const info = await stat(path)
  const handle = await open(path, 'r')
  try {
    const bytes = Math.min(info.size, METADATA_PREFIX_BYTES)
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const complete = bytesRead < info.size ? text.slice(0, Math.max(0, text.lastIndexOf('\n'))) : text
    const metadata = {
      path,
      sessionId: basename(path, extname(path)),
      cwd: null,
      title: null,
      model: null,
      createdAt: Number.isFinite(info.birthtimeMs) ? info.birthtimeMs : info.mtimeMs,
      updatedAt: info.mtimeMs,
      hasHistory: info.size > 0,
    }
    let firstPrompt = null
    let firstTimestamp = null

    for (const line of complete.split(/\r?\n/)) {
      if (!line.trim()) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      metadata.sessionId = String(record.sessionId ?? metadata.sessionId)
      if (!metadata.cwd && record.cwd) metadata.cwd = resolve(String(record.cwd))
      if (record.type === 'custom-title') metadata.title = cleanTitle(record.customTitle ?? record.title ?? record.name) || metadata.title
      if (record.type === 'ai-title' && !metadata.title) metadata.title = cleanTitle(record.aiTitle)
      if (!metadata.model && record.type === 'assistant' && record.message?.model) metadata.model = String(record.message.model)
      const timestamp = timestampMs(record.timestamp, null)
      if (timestamp !== null && firstTimestamp === null) firstTimestamp = timestamp
      if (!firstPrompt && record.type === 'user' && record.isMeta !== true) {
        firstPrompt = visibleUserText(record.message?.content)
      }
    }

    if (!metadata.title) metadata.title = cleanTitle(firstPrompt)?.slice(0, 80) || 'Claude Code'
    if (firstTimestamp !== null) metadata.createdAt = firstTimestamp
    return metadata
  } finally {
    await handle.close()
  }
}

/** Convert a native Claude Code JSONL transcript to the common A2S event model. */
export async function loadClaudeHistory(path) {
  const events = []
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let seq = 0
  let turn = 0
  let turnOpen = false
  let turnLastTime = null
  let lastTime = Date.now()
  let actualModel = null

  const append = (type, time, data) => {
    lastTime = timestampMs(time, lastTime)
    events.push({ type, seq: ++seq, time: lastTime, data })
    if (type !== 'turn/end') turnLastTime = lastTime
  }
  const endTurn = () => {
    if (!turnOpen) return
    // A later follow-up starts a new turn, but its timestamp must not inflate
    // the previous turn's duration. Close at that turn's last native record.
    append('turn/end', turnLastTime ?? lastTime, { turn, reason: { kind: 'completed' } })
    turnOpen = false
    turnLastTime = null
  }
  const ensureTurn = (time) => {
    if (turnOpen) return
    turn += 1
    append('turn/start', time, { turn })
    turnOpen = true
  }

  for await (const line of lines) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.isSidechain === true) continue
    const time = timestampMs(record.timestamp, lastTime)

    if (record.type === 'user') {
      const blocks = Array.isArray(record.message?.content)
        ? record.message.content
        : (typeof record.message?.content === 'string' ? [{ type: 'text', text: record.message.content }] : [])
      const toolResults = blocks.filter((block) => block?.type === 'tool_result')
      const text = record.isMeta === true ? '' : visibleUserText(blocks)

      if (text) {
        endTurn()
        ensureTurn(time)
        const messageId = String(record.uuid ?? record.promptId ?? `native-user-${seq + 1}`)
        append('user/message', time, {
          turn,
          clientMessageId: record.promptId ?? null,
          source: { kind: 'user', rpcId: record.promptId ?? messageId },
          message: {
            id: messageId,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user', rpcId: record.promptId ?? messageId },
          },
        })
      }

      if (toolResults.length) ensureTurn(time)
      for (const block of toolResults) {
        append('tool/result', time, {
          turn,
          callId: String(block.tool_use_id ?? block.id ?? `native-tool-${seq + 1}`),
          output: contentText(block.content),
          error: block.is_error === true ? { message: contentText(block.content) || 'tool failed' } : null,
        })
      }
      continue
    }

    if (record.type !== 'assistant') continue
    ensureTurn(time)
    if (record.message?.model) actualModel = String(record.message.model)
    const content = Array.isArray(record.message?.content) ? record.message.content : []
    const messageBlocks = []
    let messagePart = 0
    const flushMessage = () => {
      if (!messageBlocks.length) return
      const baseId = String(record.message?.id ?? record.uuid ?? `native-assistant-${seq + 1}`)
      append('assistant/message', time, {
        turn,
        message: {
          id: messagePart ? `${baseId}:part-${messagePart}` : baseId,
          role: 'assistant',
          content: messageBlocks.splice(0),
        },
        usage: record.message?.usage,
      })
      messagePart += 1
    }
    for (const block of content) {
      if (block?.type === 'text' && block.text) messageBlocks.push({ type: 'text', text: String(block.text) })
      else if (block?.type === 'thinking' && block.thinking) messageBlocks.push({ type: 'reasoning', text: String(block.thinking) })
      else if (block?.type === 'tool_use') {
        flushMessage()
        append('tool/call', time, {
          turn,
          callId: String(block.id ?? `native-tool-${seq + 1}`),
          name: String(block.name ?? 'tool'),
          arguments: block.input ?? {},
        })
      }
    }
    flushMessage()
  }

  endTurn()
  const truncated = events.length > MAX_IMPORTED_EVENTS
  const selected = truncated ? events.slice(-MAX_IMPORTED_EVENTS) : events
  return {
    events: selected,
    eventSeq: selected.at(-1)?.seq ?? 0,
    turn,
    actualModel,
    truncated,
  }
}

function visibleUserText(content) {
  const blocks = Array.isArray(content) ? content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content.map((part) => typeof part === 'string' ? part : part?.text ?? JSON.stringify(part)).join('\n')
}

function timestampMs(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function cleanTitle(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text || null
}

function pathAllowed(path, roots) {
  const normalized = resolve(String(path)).toLowerCase()
  return roots.some((root) => {
    const candidate = resolve(String(root)).toLowerCase()
    return normalized === candidate || normalized.startsWith(`${candidate}\\`) || normalized.startsWith(`${candidate}/`)
  })
}
