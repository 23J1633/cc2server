import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { replaceFilePortable } from './a2s/shared-config.js'

export class SessionStore {
  constructor(file, logger) {
    this.file = file
    this.logger = logger
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      return Array.isArray(parsed?.sessions) ? parsed.sessions : []
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger.warn(`cannot read session store ${this.file}: ${error.message}`)
      return []
    }
  }

  async save(sessions) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const document = {
      version: 2,
      updatedAt: new Date().toISOString(),
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        claudeSessionId: session.claudeSessionId,
        cwd: session.cwd,
        title: session.title,
        model: session.requestedModel ?? session.model,
        requestedModel: session.requestedModel,
        actualModel: session.model,
        reasoningEffort: session.reasoningEffort,
        permissionMode: session.permissionMode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archived: session.archived === true,
        turn: session.turn,
        eventSeq: session.eventSeq,
        historyAvailable: session.historyAvailable === true,
        // Claude's native JSONL remains the source of truth. This bounded tail
        // covers the short window before Claude has assigned a native session
        // id and also makes bridge restarts lossless when that file is absent.
        events: Array.isArray(session.events) ? session.events.slice(-2000) : [],
      })),
    }
    const temporary = `${this.file}.${process.pid}.${process.hrtime.bigint()}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await replaceFilePortable(temporary, this.file)
  }
}
