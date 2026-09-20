import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

const TERMINAL_STATES = new Set(['finished', 'errored', 'cancelled'])
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const EVENT_LIMIT = 20_000

export class ClaudeSession extends EventEmitter {
  constructor(options) {
    super()
    this.sessionId = options.sessionId ?? `cc-${randomUUID()}`
    this.claudeSessionId = options.claudeSessionId ?? null
    this.cwd = options.cwd
    this.title = options.title || leafName(options.cwd) || 'Claude Code'
    // `requestedModel` is the alias/full id selected by the user. `model` is the
    // concrete id reported by Claude Code after initialization (for example an
    // input of "sonnet" may resolve to "claude-sonnet-4-6"). Keep both so the
    // server can display what is really executing without losing the CLI input.
    this.requestedModel = options.requestedModel ?? options.model ?? null
    this.model = options.actualModel ?? options.model ?? null
    this.reasoningEffort = normalizeEffort(options.reasoningEffort)
    this.permissionMode = options.permissionMode ?? 'default'
    this.executable = options.executable ?? 'claude'
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : []
    this.spawnProcess = options.spawnProcess ?? spawn
    this.logger = options.logger
    this.createdAt = options.createdAt ?? Date.now()
    this.updatedAt = options.updatedAt ?? this.createdAt
    this.archived = options.archived === true
    this.state = 'idle'
    this.running = false
    this.process = null
    this.buffer = ''
    this.stderrTail = ''
    this.turn = Number.isFinite(options.turn) ? Number(options.turn) : 0
    this.events = Array.isArray(options.events) ? options.events.slice(-EVENT_LIMIT) : []
    this.eventSeq = Math.max(
      Number.isFinite(options.eventSeq) ? Number(options.eventSeq) : 0,
      ...this.events.map((event) => Number(event?.seq) || 0),
    )
    this.historyAvailable = options.historyAvailable === true || this.events.length > 0
    this.historyLoaded = options.historyLoaded !== false
    this.historyLoader = options.historyLoader ?? null
    this.nativeHistoryPath = options.nativeHistoryPath ?? null
    this.historyLoadPromise = null
    this.streamIndex = -1
    this.streamRevision = 0
    this.pendingInputs = []
  }

  summary() {
    return {
      sessionId: this.sessionId,
      nativeSessionId: this.claudeSessionId,
      title: this.title,
      cwd: this.cwd,
      model: this.#modelSelection(),
      permissionMode: this.permissionMode,
      running: this.running,
      status: this.state,
      blank: !this.historyAvailable && this.events.length === 0,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      archived: this.archived,
      attached: !!this.process,
    }
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      header: {
        id: this.sessionId,
        cwd: this.cwd,
        createdAt: this.createdAt,
        title: this.title,
        origin: 'cc2server',
      },
      title: this.title,
      cwd: this.cwd,
      running: this.running,
      status: this.state,
      seq: this.eventSeq,
      model: this.#modelSelection(),
      approvalPolicy: this.permissionMode,
      projections: {
        asOfSeq: this.eventSeq,
        values: { title: this.title },
      },
    }
  }

  async prompt(text, mode = 'queue', clientMessageId = null) {
    if (!text.trim()) throw Object.assign(new Error('prompt text is empty'), { code: 'invalid_params' })
    if (!this.process || TERMINAL_STATES.has(this.state)) await this.#spawn()
    const requestId = clientMessageId || randomUUID()
    this.turn += 1
    this.running = true
    this.state = 'working'
    this.updatedAt = Date.now()
    this.streamRevision += 1
    this.streamIndex = -1
    this.#record('turn/start', { turn: this.turn })
    this.#record('user/message', {
      turn: this.turn,
      clientMessageId: requestId,
      requestId,
      source: { kind: 'user', rpcId: requestId },
      message: {
        id: requestId,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: requestId },
      },
    })
    // Claude Code's stream-json transport echoes the submitted user message
    // back on stdout. Keep one correlation entry so that transport echo can be
    // consumed instead of becoming a second durable user bubble.
    this.pendingInputs.push({ text: normalizeInputText(text), requestId, turn: this.turn })
    if (this.pendingInputs.length > 32) this.pendingInputs.splice(0, this.pendingInputs.length - 32)
    this.#write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    this.emit('status', this.summary())
    return { accepted: true, mode, sessionId: this.sessionId, turn: this.turn, clientMessageId: requestId, requestId }
  }

  interrupt() {
    if (!this.process || !this.running) return { interrupted: false }
    this.#write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
    this.running = false
    this.state = 'idle'
    this.#record('turn/end', { turn: this.turn, reason: { kind: 'interrupted' } })
    this.emit('status', this.summary())
    return { interrupted: true }
  }

  setModel(model, reasoningEffort = undefined) {
    if (!model || typeof model !== 'string') throw Object.assign(new Error('model is required'), { code: 'invalid_params' })
    const effort = reasoningEffort === undefined ? this.reasoningEffort : normalizeEffort(reasoningEffort, true)
    this.requestedModel = model
    // Until Claude reports the resolved id, showing the exact request is more
    // truthful than retaining the concrete id of the previous model.
    this.model = model
    this.reasoningEffort = effort
    if (this.process) {
      this.#write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_model', model } })
      this.#write({
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'apply_flag_settings', settings: { effortLevel: effort } },
      })
    }
    this.updatedAt = Date.now()
    this.emit('changed')
    const selected = this.#modelSelection()
    return { sessionId: this.sessionId, model: selected, selected }
  }

  setPermissionMode(mode) {
    const allowed = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']
    if (!allowed.includes(mode)) throw Object.assign(new Error(`unsupported permission mode ${mode}`), { code: 'invalid_params', details: { allowed } })
    this.permissionMode = mode
    if (this.process) this.#write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_permission_mode', mode } })
    this.updatedAt = Date.now()
    this.emit('changed')
    return { sessionId: this.sessionId, preset: permissionPreset(mode), permissionMode: mode, available: ['read-only', 'workspace-write', 'full-access'] }
  }

  rename(title) {
    if (!title?.trim()) throw Object.assign(new Error('title is required'), { code: 'invalid_params' })
    this.title = title.trim().slice(0, 200)
    this.updatedAt = Date.now()
    this.emit('changed')
    return { sessionId: this.sessionId, title: this.title }
  }

  history({ beforeSeq, limit = 200 } = {}) {
    let events = this.events
    if (Number.isFinite(beforeSeq)) events = events.filter((event) => event.seq < beforeSeq)
    const window = events.slice(-Math.max(1, Math.min(Number(limit) || 200, 1000)))
    return { events: window, hasMore: window.length < events.length, oldestSeq: window[0]?.seq ?? null, newestSeq: window.at(-1)?.seq ?? null }
  }

  setHistorySource(path, loader) {
    this.nativeHistoryPath = path
    this.historyLoader = loader
    this.historyAvailable = true
    this.historyLoaded = false
  }

  async ensureHistoryLoaded() {
    if (this.historyLoaded || !this.historyLoader) return this.history()
    if (this.historyLoadPromise) return this.historyLoadPromise
    this.historyLoadPromise = (async () => {
      const loaded = await this.historyLoader()
      if (Array.isArray(loaded?.events)) this.events = loaded.events.slice(-EVENT_LIMIT)
      this.eventSeq = Math.max(Number(loaded?.eventSeq) || 0, ...this.events.map((event) => Number(event?.seq) || 0))
      this.turn = Math.max(Number(loaded?.turn) || 0, ...this.events.map((event) => Number(event?.data?.turn) || 0))
      if (loaded?.actualModel) this.model = loaded.actualModel
      this.historyAvailable = this.events.length > 0
      this.historyLoaded = true
      this.updatedAt = Math.max(this.updatedAt, ...this.events.map((event) => Number(event?.time) || 0))
      this.emit('changed')
      return this.history()
    })()
    try { return await this.historyLoadPromise } finally { this.historyLoadPromise = null }
  }

  async close(cancel = false) {
    const processHandle = this.process
    this.process = null
    if (!processHandle) return
    if (cancel) {
      try { processHandle.kill() } catch {}
      this.state = 'cancelled'
    } else {
      try { processHandle.stdin.end() } catch {}
    }
    this.running = false
  }

  async #spawn() {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    if (this.claudeSessionId) args.push('--resume', this.claudeSessionId)
    if (this.requestedModel) args.push('--model', this.requestedModel)
    if (this.reasoningEffort) args.push('--effort', this.reasoningEffort)
    if (this.permissionMode) args.push('--permission-mode', this.permissionMode)
    args.push(...this.extraArgs)
    const child = this.spawnProcess(this.executable, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && !/\.exe$/i.test(this.executable),
      env: { ...process.env },
    })
    this.process = child
    this.buffer = ''
    this.stderrTail = ''
    this.state = 'starting'
    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('Claude Code process did not start within 15 seconds'))
      }, 15000)
      child.once('spawn', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.state = 'idle'
        resolve()
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.process = null
        this.state = 'errored'
        reject(error)
      })
    })
    child.stdout.on('data', (chunk) => this.#onStdout(chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-8192)
    })
    child.on('exit', (code, signal) => {
      if (this.process !== child) return
      this.process = null
      const wasRunning = this.running
      this.running = false
      this.state = code === 0 ? 'finished' : 'errored'
      this.updatedAt = Date.now()
      if (wasRunning) {
        this.#record('turn/end', {
          turn: this.turn,
          reason: code === 0 ? { kind: 'completed' } : { kind: 'error', message: this.stderrTail || `Claude exited with ${code ?? signal}` },
        })
      }
      this.emit('status', this.summary())
      this.emit('changed')
    })
    child.on('error', (error) => this.logger.warn(`Claude session ${this.sessionId}: ${error.message}`))
  }

  #onStdout(chunk) {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      try { this.#onMessage(JSON.parse(line)) } catch (error) { this.logger.debug(`ignored non-JSON Claude output: ${error.message}`) }
    }
  }

  #onMessage(message) {
    this.updatedAt = Date.now()
    if (message.type === 'system' && message.subtype === 'init') {
      this.claudeSessionId = message.session_id ?? this.claudeSessionId
      this.model = message.model ?? this.model
      this.reasoningEffort = normalizeEffort(
        message.effort ?? message.effort_level ?? message.effortLevel ?? this.reasoningEffort,
      )
      this.state = 'idle'
      this.emit('changed')
      return
    }

    if (message.type === 'stream_event') {
      const event = message.event ?? {}
      if (event.type === 'message_start' && event.message?.model) {
        this.model = event.message.model
        this.emit('changed')
      }
      if (event.type === 'content_block_delta') {
        const text = event.delta?.text ?? event.delta?.thinking ?? ''
        if (text) {
          this.streamIndex += 1
          this.emit('event', {
            topic: 'assistant',
            kind: 'session/assistant-stream',
            sessionId: this.sessionId,
            data: {
              sessionId: this.sessionId,
              frame: {
                type: 'chunk',
                revision: this.streamRevision,
                attemptId: `${this.sessionId}:${this.turn}`,
                index: this.streamIndex,
                chunk: { delta: { text } },
              },
            },
          })
        }
      }
      return
    }

    if (message.type === 'assistant') {
      if (message.message?.model) this.model = message.message.model
      this.running = true
      this.state = 'working'
      const blocks = normalizeClaudeBlocks(message.message?.content ?? [])
      if (blocks.length) this.#record('assistant/message', { turn: this.turn, message: { id: message.message?.id, role: 'assistant', content: blocks }, usage: message.message?.usage })
      return
    }

    if (message.type === 'user') {
      const blocks = normalizeClaudeUserBlocks(message.message?.content ?? [])
      const textBlocks = blocks.filter((block) => block.type === 'text')
      const toolResultBlocks = blocks.filter((block) => block.type === 'tool-result')
      const echoedText = normalizeInputText(textBlocks.map((block) => block.text).join('\n'))
      const pendingIndex = echoedText
        ? this.pendingInputs.findIndex((entry) => entry.text === echoedText)
        : -1
      const pending = pendingIndex >= 0 ? this.pendingInputs.splice(pendingIndex, 1)[0] : null

      // Tool-result blocks are genuine derived events and must be retained so
      // the transcript can attach them to their tool calls. Only the text echo
      // matching our already-recorded input is suppressed.
      const durableBlocks = [
        ...(pending ? [] : textBlocks),
        ...toolResultBlocks,
      ]
      if (durableBlocks.length) {
        this.#record('user/message', {
          turn: pending?.turn ?? this.turn,
          ...(pending ? {
            clientMessageId: pending.requestId,
            requestId: pending.requestId,
            source: { kind: 'user', rpcId: pending.requestId },
          } : {}),
          message: {
            role: 'user',
            content: durableBlocks,
            ...(pending ? { source: { kind: 'user', rpcId: pending.requestId } } : {}),
          },
        })
      }
      return
    }

    if (message.type === 'result') {
      this.pendingInputs = this.pendingInputs.filter((entry) => entry.turn !== this.turn)
      this.running = false
      this.state = message.is_error ? 'errored' : 'idle'
      if (typeof message.result === 'string' && message.result.trim()) {
        this.#record('assistant/message', { turn: this.turn, message: { role: 'assistant', content: [{ type: 'text', text: message.result }] }, usage: message.usage })
      }
      this.#record('turn/end', {
        turn: this.turn,
        reason: message.is_error ? { kind: 'error', message: message.result || message.subtype || 'Claude Code failed' } : { kind: 'completed' },
      })
      this.emit('event', {
        topic: 'assistant', kind: 'session/assistant-stream', sessionId: this.sessionId,
        data: { sessionId: this.sessionId, frame: { type: 'end', revision: this.streamRevision, attemptId: `${this.sessionId}:${this.turn}`, index: this.streamIndex, outcome: message.is_error ? 'error' : 'completed' } },
      })
      this.emit('status', this.summary())
      this.emit('changed')
    }
  }

  #record(type, data) {
    const event = { type, seq: ++this.eventSeq, time: Date.now(), data }
    this.events.push(event)
    this.historyAvailable = true
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT)
    this.emit('event', { topic: 'sessions', kind: 'session/event', sessionId: this.sessionId, data: { sessionId: this.sessionId, ...event } })
    return event
  }

  #write(message) {
    if (!this.process?.stdin.writable) throw Object.assign(new Error('Claude Code process is not writable'), { code: 'agent_busy', retryable: true })
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #modelSelection() {
    const model = this.model ?? this.requestedModel
    if (!model) return null
    return {
      provider: 'anthropic',
      model,
      ...(this.requestedModel ? { requestedModel: this.requestedModel } : {}),
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
    }
  }
}

function normalizeEffort(value, strict = false) {
  if (value == null || value === '') return null
  const normalized = String(value).trim().toLowerCase()
  if (EFFORT_LEVELS.has(normalized)) return normalized
  if (strict) {
    throw Object.assign(new Error(`unsupported effort level ${value}`), {
      code: 'invalid_params',
      details: { allowed: [...EFFORT_LEVELS] },
    })
  }
  return null
}

function normalizeClaudeBlocks(content) {
  const blocks = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text') blocks.push({ type: 'text', text: String(block.text ?? '') })
    else if (block?.type === 'thinking') blocks.push({ type: 'reasoning', text: String(block.thinking ?? '') })
    else if (block?.type === 'tool_use') blocks.push({ type: 'tool-call', id: block.id, name: block.name, arguments: block.input ?? {} })
  }
  return blocks
}

function normalizeClaudeUserBlocks(content) {
  const blocks = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text') blocks.push({ type: 'text', text: String(block.text ?? '') })
    else if (block?.type === 'tool_result') blocks.push({ type: 'tool-result', toolCallId: block.tool_use_id, text: contentText(block.content), isError: block.is_error === true })
  }
  return blocks
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  return content.map((part) => typeof part === 'string' ? part : part?.text ?? JSON.stringify(part)).join('\n')
}

function normalizeInputText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim()
}

function permissionPreset(mode) {
  if (mode === 'plan') return 'read-only'
  if (mode === 'bypassPermissions') return 'full-access'
  return 'workspace-write'
}

function leafName(value) {
  return String(value ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
}
