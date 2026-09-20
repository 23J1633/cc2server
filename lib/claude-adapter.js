import { EventEmitter } from 'node:events'
import { access, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { ClaudeSession } from './claude-session.js'
import { discoverClaudeHistories, loadClaudeHistory } from './claude-history.js'
import { SessionStore } from './session-store.js'
import { WorkspaceStore } from './workspace-store.js'
import { ERROR_CODES, protocolError } from './a2s/protocol.js'
import { tr } from './a2s/locale.js'
import { TerminalManager } from './terminal-manager.js'

const FILE_READ_LIMIT = 4 * 1024 * 1024

export class ClaudeAdapter extends EventEmitter {
  constructor(config, { logger, configDir }) {
    super()
    this.config = config
    this.logger = logger
    this.configDir = configDir ?? process.cwd()
    this.store = new SessionStore(join(this.configDir, 'claude-sessions.json'), logger)
    this.workspaceStore = new WorkspaceStore(join(this.configDir, 'claude-workspaces.json'), logger)
    this.registeredWorkspaces = []
    this.sessions = new Map()
    this.agentName = 'Claude Code'
    this.icon = 'claude'
    this.saveTimer = null
    this.terminals = new TerminalManager(this.config, this.logger)
    this.terminals.on('output', (data) => this.emit('event', { topic: 'terminal', kind: 'terminal/output', data }))
    this.terminals.on('exit', (data) => this.emit('event', { topic: 'terminal', kind: 'terminal/exit', data }))
  }

  async init() {
    this.registeredWorkspaces = await this.workspaceStore.load()
    for (const saved of await this.store.load()) this.#attach(new ClaudeSession({ ...saved, executable: this.config.executable, logger: this.logger }))
    await this.#discoverNativeHistories()
    return this
  }

  hostFacts() { return { hostname: hostname() } }
  liveSessionCount() { return [...this.sessions.values()].filter((session) => session.running).length }

  capabilities() {
    return {
      sessions: true,
      sessionList: true,
      sessionHistory: true,
      sessionCreate: true,
      sessionPrompt: true,
      sessionInterrupt: true,
      sessionFork: true,
      sessionRename: true,
      sessionArchive: true,
      sessionSearch: false,
      sessionSelectModel: true,
      queueUpdate: false,
      modelCatalog: true,
      commands: true,
      jobs: false,
      goals: false,
      approvalPolicy: true,
      approvalAnswer: false,
      questions: false,
      workspaces: true,
      workspaceRegistry: true,
      workspaceMutation: true,
      directoryMutation: true,
      projections: true,
      sessionEvents: true,
      permissionPresets: true,
      fileBrowser: true,
      attachments: false,
      pluginManagement: false,
      terminal: true,
      agentType: 'claude',
    }
  }

  async handle(method, params) {
    switch (method) {
      case 'instance.info': return this.instanceInfo()
      case 'instance.health': return { ok: true, agentType: 'claude', executable: this.config.executable, sessions: this.sessions.size, locale: this.config.resolvedLocale }
      case 'instance.key': return { keyFingerprint: fingerprint(this.config.key), shared: true, note: tr(this.config.locale, '由 A2Switch 统一管理', 'Managed by A2Switch') }
      case 'session.list': return { items: this.#list() }
      case 'workspace.list': return { items: this.#workspaces() }
      case 'workspace.create': return this.#workspaceCreate(params)
      case 'workspace.rename': return this.#workspaceRename(params)
      case 'workspace.remove': return this.#workspaceRemove(params)
      case 'session.create': return this.#create(params)
      case 'session.get': return this.#session(params.sessionId).snapshot()
      case 'session.prompt': return this.#prompt(params)
      case 'session.interrupt': return this.#session(params.sessionId).interrupt()
      case 'session.cancel': return this.#cancel(params.sessionId)
      case 'session.history': return this.#history(params)
      case 'session.events': return this.#events(params)
      case 'session.rename': return this.#session(params.sessionId).rename(params.title ?? params.name)
      case 'session.fork': return this.#fork(params)
      case 'session.archive': return this.#archive(params.sessionId)
      case 'session.modelCatalog': return this.#modelCatalog()
      case 'session.selectModel': return this.#session(params.sessionId).setModel(params.model, params.reasoningEffort)
      case 'session.approvalPolicy': return this.#session(params.sessionId).setPermissionMode(params.policy)
      case 'session.permission': return this.#permission(params)
      case 'command.list': return this.#commandList()
      case 'command.run': return this.#command(params)
      case 'workspace.fs.list': return this.#fsList(params)
      case 'workspace.fs.read': return this.#fsRead(params)
      case 'workspace.fs.roots': return this.#fsRoots()
      case 'workspace.fs.mkdir': return this.#fsMkdir(params)
      case 'job.list': return { items: [] }
      case 'terminal.open': return this.terminals.open(params)
      case 'terminal.list': return { items: this.terminals.list() }
      case 'terminal.attach': return this.terminals.attach(params.terminalId)
      case 'terminal.keepAlive': return this.terminals.keepAlive(params.terminalId)
      case 'terminal.write': return this.terminals.write(params.terminalId, params.data)
      case 'terminal.resize': return this.terminals.resize(params.terminalId, params.cols, params.rows)
      case 'terminal.close': return this.terminals.close(params.terminalId)
      default: throw protocolError(ERROR_CODES.UNKNOWN_METHOD, `cc2server does not implement ${method}`)
    }
  }

  async snapshots(sessionIds = []) {
    const selected = sessionIds.length ? sessionIds.map((id) => this.sessions.get(id)).filter(Boolean) : [...this.sessions.values()]
    const events = [
      { topic: 'instance', kind: 'instance/info', data: this.instanceInfo() },
      ...this.#list().map((item) => ({ topic: 'sessions', kind: 'session/added', sessionId: item.sessionId, data: item })),
    ]
    for (const session of selected) events.push({ topic: 'sessions', kind: 'session/snapshot', sessionId: session.sessionId, data: session.snapshot() })
    return events
  }

  instanceInfo() {
    return {
      instanceId: this.config.instanceId,
      deviceId: this.config.deviceId,
      displayName: this.config.displayName,
      agentType: 'claude',
      agentName: this.agentName,
      locale: this.config.resolvedLocale,
      localeSetting: this.config.locale,
      executable: this.config.executable,
      sessions: this.sessions.size,
      liveSessions: this.liveSessionCount(),
      capabilities: this.capabilities(),
    }
  }

  async close() {
    clearTimeout(this.saveTimer)
    this.terminals.closeAll()
    await Promise.allSettled([...this.sessions.values()].map((session) => session.close()))
    await this.#save()
  }

  #list() {
    return [...this.sessions.values()].filter((session) => !session.archived).map((session) => session.summary()).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  #workspaces() {
    const groups = new Map()
    for (const entry of this.registeredWorkspaces) {
      const cwd = resolve(String(entry.path))
      groups.set(pathKey(cwd), {
        id: entry.id ?? cwd, path: cwd, cwd,
        name: entry.title || basename(cwd), title: entry.title || basename(cwd), sessionIds: [],
        hidden: entry.hidden === true,
      })
    }
    for (const session of this.sessions.values()) {
      if (session.archived) continue
      const cwd = session.cwd
      const key = pathKey(cwd)
      if (!groups.has(key)) groups.set(key, { id: cwd, path: cwd, cwd, name: basename(cwd) || cwd, title: basename(cwd) || cwd, sessionIds: [] })
      groups.get(key).sessionIds.push(session.sessionId)
    }
    return [...groups.values()]
  }

  async #workspaceCreate(params) {
    const path = resolve(String(params.path ?? ''))
    assertAllowedPath(path, this.#baseRoots())
    const info = await stat(path).catch(() => null)
    if (!info?.isDirectory()) throw protocolError(ERROR_CODES.INVALID_PARAMS, `working directory does not exist: ${path}`)
    const key = pathKey(path)
    const title = String(params.title || basename(path) || path).slice(0, 200)
    const existing = this.registeredWorkspaces.find((entry) => pathKey(entry.path) === key)
    const workspace = existing ?? { id: path, path, createdAt: Date.now() }
    workspace.title = title
    workspace.hidden = false
    workspace.updatedAt = Date.now()
    if (!existing) this.registeredWorkspaces.push(workspace)
    await this.workspaceStore.save(this.registeredWorkspaces)
    this.#workspaceChanged('created', workspace)
    return { workspace: { ...workspace, cwd: path, name: title, sessionIds: [] } }
  }

  async #workspaceRename(params) {
    const workspace = this.#workspaceForMutation(params, true)
    workspace.title = String(params.title ?? '').trim().slice(0, 200)
    if (!workspace.title) throw protocolError(ERROR_CODES.INVALID_PARAMS, 'title is required')
    workspace.hidden = false
    workspace.updatedAt = Date.now()
    await this.workspaceStore.save(this.registeredWorkspaces)
    this.#workspaceChanged('renamed', workspace)
    return { workspace: { ...workspace, cwd: workspace.path, name: workspace.title } }
  }

  async #workspaceRemove(params) {
    const workspace = this.#workspaceForMutation(params, true)
    workspace.hidden = true
    await this.workspaceStore.save(this.registeredWorkspaces)
    this.#workspaceChanged('removed', workspace)
    return { removed: true }
  }

  #workspaceForMutation(params, createIfInferred = false) {
    const id = params.id == null ? null : String(params.id)
    const key = params.path == null ? null : pathKey(resolve(String(params.path)))
    let workspace = this.registeredWorkspaces.find((entry) => (id && String(entry.id) === id) || (key && pathKey(entry.path) === key))
    if (!workspace && createIfInferred && key) {
      const inferred = [...this.sessions.values()].some((session) => pathKey(session.cwd) === key)
      if (inferred) {
        const path = resolve(String(params.path))
        workspace = { id: path, path, title: basename(path) || path, createdAt: Date.now(), updatedAt: Date.now(), hidden: false }
        this.registeredWorkspaces.push(workspace)
      }
    }
    if (!workspace) throw protocolError(ERROR_CODES.NOT_FOUND, 'workspace is not registered')
    return workspace
  }

  #workspaceChanged(action, workspace) {
    this.emit('event', { topic: 'sessions', kind: 'workspace/changed', data: { action, workspace: { ...workspace }, at: Date.now() } })
  }

  async #create(params) {
    const cwd = resolve(String(params.cwd || this.config.defaultCwd || process.cwd()))
    try { await access(cwd) } catch { throw protocolError(ERROR_CODES.INVALID_PARAMS, `working directory does not exist: ${cwd}`) }
    assertAllowedPath(cwd, this.#allowedRoots())
    const session = this.#attach(new ClaudeSession({
      cwd,
      title: params.title,
      model: params.model ?? this.config.model,
      reasoningEffort: params.reasoningEffort ?? this.config.reasoningEffort,
      permissionMode: params.permissionMode ?? this.config.permissionMode,
      executable: this.config.executable,
      extraArgs: this.config.extraArgs,
      logger: this.logger,
    }))
    await this.#save()
    this.emit('event', { topic: 'sessions', kind: 'session/created', sessionId: session.sessionId, data: { sessionId: session.sessionId, header: session.snapshot().header } })
    return { sessionId: session.sessionId, session: session.summary() }
  }

  async #prompt(params) {
    const session = this.#session(params.sessionId)
    const text = promptText(params)
    const result = await session.prompt(text, params.mode, params.clientMessageId ?? params.requestId ?? null)
    this.#scheduleSave()
    return result
  }

  async #cancel(sessionId) {
    const session = this.#session(sessionId)
    await session.close(true)
    this.#scheduleSave()
    return { cancelled: true, sessionId }
  }

  async #history(params) {
    const session = this.#session(params.sessionId)
    await session.ensureHistoryLoaded()
    const out = session.history({ beforeSeq: params.beforeSeq, limit: params.maxMessages })
    return { records: out.events.map((event) => ({ type: 'event', event })), hasMore: out.hasMore, oldestSeq: out.oldestSeq }
  }

  async #events(params) {
    const session = this.#session(params.sessionId)
    await session.ensureHistoryLoaded()
    const out = session.history({ beforeSeq: params.beforeSeq, limit: params.limit })
    return out
  }

  async #fork(params) {
    const source = this.#session(params.sessionId)
    const fork = this.#attach(new ClaudeSession({
      claudeSessionId: source.claudeSessionId,
      cwd: source.cwd,
      title: params.title || `${source.title} (fork)`,
      model: source.requestedModel ?? source.model,
      actualModel: source.model,
      reasoningEffort: source.reasoningEffort,
      permissionMode: source.permissionMode,
      executable: this.config.executable,
      extraArgs: [...(this.config.extraArgs ?? []), '--fork-session'],
      logger: this.logger,
    }))
    await this.#save()
    return { sessionId: fork.sessionId, sourceSessionId: source.sessionId }
  }

  async #archive(sessionId) {
    const session = this.#session(sessionId)
    session.archived = true
    session.updatedAt = Date.now()
    await session.close()
    await this.#save()
    this.emit('event', { topic: 'sessions', kind: 'session/removed', sessionId, data: { sessionId } })
    return { archived: true, sessionId }
  }

  #permission(params) {
    const session = this.#session(params.sessionId)
    if (!params.preset) return { sessionId: session.sessionId, preset: presetOf(session.permissionMode), permissionMode: session.permissionMode, available: ['read-only', 'workspace-write', 'full-access'] }
    const mode = params.preset === 'read-only' ? 'plan' : params.preset === 'full-access' ? 'bypassPermissions' : 'acceptEdits'
    return session.setPermissionMode(mode)
  }

  async #command(params) {
    const name = String(params.line ?? params.command ?? params.name ?? '').trim()
    if (!name) throw protocolError(ERROR_CODES.INVALID_PARAMS, 'command is required')
    return this.#session(params.sessionId).prompt(name.startsWith('/') ? name : `/${name}`, 'steer')
  }

  #commandList() {
    return {
      items: [
        { name: 'compact', description: '压缩当前会话上下文' },
        { name: 'context', description: '查看当前上下文使用情况' },
        { name: 'cost', description: '查看当前会话用量' },
      ],
    }
  }

  async #fsList(params) {
    const requested = resolve(String(params.path || this.sessions.get(params.sessionId)?.cwd || this.config.defaultCwd))
    const root = await realpath(requested)
    assertAllowedPath(root, this.#allowedRoots())
    const entries = await readdir(root, { withFileTypes: true })
    const selected = entries.slice(0, 1000)
    return {
      path: root,
      entries: await Promise.all(selected.map(async (entry) => {
        const fullPath = resolve(root, entry.name)
        const info = await stat(fullPath).catch(() => null)
        return { name: entry.name, path: fullPath, type: entry.isDirectory() ? 'dir' : 'file', size: info?.size ?? null, modifiedAt: info?.mtimeMs ?? null }
      })),
      truncated: entries.length > selected.length,
    }
  }

  async #fsRead(params) {
    const requested = resolve(String(params.path ?? ''))
    const path = await realpath(requested)
    assertAllowedPath(path, this.#allowedRoots())
    const info = await stat(path)
    if (!info.isFile()) throw protocolError(ERROR_CODES.INVALID_PARAMS, `path is not a file: ${path}`)
    const maxBytes = Math.min(Math.max(Number(params.maxBytes) || 262144, 1), FILE_READ_LIMIT)
    if (info.size > maxBytes) throw protocolError(ERROR_CODES.PAYLOAD_TOO_LARGE, `file exceeds ${maxBytes} bytes`)
    return filePayload(path, await readFile(path), info)
  }

  async #fsRoots() {
    const roots = []
    for (const candidate of this.#baseRoots()) {
      const path = await realpath(candidate).catch(() => null)
      if (path && !roots.some((entry) => pathKey(entry.path) === pathKey(path))) roots.push({ path, name: basename(path) || path })
    }
    return { roots }
  }

  async #fsMkdir(params) {
    const parent = await realpath(resolve(String(params.path ?? params.parent ?? '')))
    assertAllowedPath(parent, this.#allowedRoots())
    const name = String(params.name ?? '').trim()
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw protocolError(ERROR_CODES.INVALID_PARAMS, 'folder name must be one path segment')
    }
    const path = resolve(parent, name)
    assertAllowedPath(path, [parent])
    await mkdir(path)
    return { path, name }
  }

  #baseRoots() {
    const configured = this.config.allowedCwdPrefixes ?? []
    return [...new Set([
      ...(configured.length ? configured : [this.config.defaultCwd, homedir()]),
      ...this.registeredWorkspaces.map((workspace) => workspace.path),
    ].filter(Boolean).map((value) => resolve(String(value))))]
  }

  #allowedRoots() {
    return [...new Set([
      ...this.#baseRoots(),
      ...[...this.sessions.values()].map((session) => session.cwd),
    ].filter(Boolean).map((value) => resolve(String(value))))]
  }

  #modelCatalog() {
    const model = this.config.model || 'sonnet'
    const models = [...new Set([model, 'sonnet', 'opus', 'haiku'])]
    const efforts = [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      { id: 'xhigh', name: 'XHigh' },
      { id: 'max', name: 'Max' },
    ]
    return {
      default: {
        provider: 'anthropic',
        model,
        ...(this.config.reasoningEffort ? { reasoningEffort: this.config.reasoningEffort } : {}),
      },
      groups: [{
        provider: 'anthropic',
        label: 'Anthropic',
        models: models.map((id) => ({
          id,
          model: id,
          // Do not prettify an id: Claude accepts aliases and full model ids,
          // and the UI must show the exact value being requested.
          label: id,
          reasoning: { defaultEffort: null, efforts },
        })),
      }],
    }
  }

  #session(id) {
    const session = this.sessions.get(String(id ?? ''))
    if (!session) throw protocolError(ERROR_CODES.SESSION_NOT_FOUND, `unknown Claude session ${String(id ?? '')}`)
    return session
  }

  #attach(session) {
    this.sessions.set(session.sessionId, session)
    session.on('event', (event) => this.emit('event', event))
    session.on('status', (status) => this.emit('status', status))
    session.on('changed', () => this.#scheduleSave())
    return session
  }

  async #discoverNativeHistories() {
    const claudeConfigDir = resolve(String(
      this.config.claudeConfigDir
      || process.env.CLAUDE_CONFIG_DIR
      || join(homedir(), '.claude'),
    ))
    const histories = await discoverClaudeHistories(claudeConfigDir)
    const byNativeId = new Map(
      [...this.sessions.values()]
        .filter((session) => session.claudeSessionId)
        .map((session) => [String(session.claudeSessionId), session]),
    )

    for (const metadata of histories) {
      let session = byNativeId.get(metadata.sessionId)
      if (!session) {
        if (!isAllowedPath(metadata.cwd, this.#baseRoots())) continue
        const preferredId = `cc-${metadata.sessionId}`
        const sessionId = this.sessions.has(preferredId) ? `cc-native-${metadata.sessionId}` : preferredId
        session = this.#attach(new ClaudeSession({
          sessionId,
          claudeSessionId: metadata.sessionId,
          cwd: metadata.cwd,
          title: metadata.title,
          model: metadata.model ?? this.config.model,
          actualModel: metadata.model,
          reasoningEffort: this.config.reasoningEffort,
          permissionMode: this.config.permissionMode,
          executable: this.config.executable,
          extraArgs: this.config.extraArgs,
          logger: this.logger,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          historyAvailable: metadata.hasHistory,
          historyLoaded: false,
          nativeHistoryPath: metadata.path,
        }))
        byNativeId.set(metadata.sessionId, session)
      }
      session.setHistorySource(metadata.path, () => loadClaudeHistory(metadata.path))
    }
  }

  #scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.#save(), 100)
    this.saveTimer.unref?.()
  }

  async #save() { await this.store.save([...this.sessions.values()]) }
}

function pathKey(path) {
  const value = resolve(String(path))
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function promptText(params) {
  if (typeof params.prompt === 'string') return params.prompt
  if (typeof params.text === 'string') return params.text
  if (!Array.isArray(params.content)) return ''
  return params.content.filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('\n')
}

function presetOf(mode) {
  if (mode === 'plan') return 'read-only'
  if (mode === 'bypassPermissions') return 'full-access'
  return 'workspace-write'
}

function fingerprint(key) {
  return key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-4)}` : '***'
}

function assertAllowedPath(path, roots) {
  if (!isAllowedPath(path, roots)) {
    throw protocolError(ERROR_CODES.FORBIDDEN, `path is outside allowed roots: ${path}`)
  }
}

function isAllowedPath(path, roots) {
  const normalized = resolve(path).toLowerCase()
  const allowed = roots.map((root) => resolve(root).toLowerCase())
  return allowed.some((root) => normalized === root || normalized.startsWith(`${root}\\`) || normalized.startsWith(`${root}/`))
}

function filePayload(path, buffer, info) {
  const mime = mimeType(path)
  const binary = mime.startsWith('image/') || mime === 'application/pdf' || buffer.subarray(0, 8192).includes(0)
  if (binary) return { path, name: basename(path), size: info.size, modifiedAt: info.mtimeMs, mime, binary: true, dataBase64: buffer.toString('base64') }
  const text = buffer.toString('utf8')
  return { path, name: basename(path), size: info.size, modifiedAt: info.mtimeMs, mime, binary: false, encoding: 'utf8', text, content: text }
}

function mimeType(path) {
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
    '.json': 'application/json', '.md': 'text/markdown', '.html': 'text/html', '.css': 'text/css',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
    '.txt': 'text/plain', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'application/xml',
  })[extname(path).toLowerCase()] ?? 'application/octet-stream'
}
