import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ClaudeAdapter } from './lib/claude-adapter.js'
import { Logger } from './lib/a2s/logger.js'
import { RelayClient } from './lib/a2s/relay-client.js'
import { defaultConfigFile, ensureSharedConfig, resolveAgentConfig } from './lib/a2s/shared-config.js'

export const VERSION = '0.1.7'

export async function loadConfig(options = {}) {
  const sharedFile = options.sharedConfigFile ?? defaultConfigFile()
  const shared = await ensureSharedConfig(sharedFile)
  let local = {}
  if (options.configFile) {
    try { local = JSON.parse(await readFile(resolve(options.configFile), 'utf8')) } catch (error) { throw new Error(`cannot read cc2server config: ${error.message}`) }
  }
  const defaultCwd = local.defaultCwd ?? options.overrides?.defaultCwd
    ?? shared.document.agents?.claude?.defaultCwd ?? process.cwd()
  const config = resolveAgentConfig(shared, 'claude', {
    executable: process.env.CLAUDE_EXE || shared.document.agents?.claude?.executable || (process.platform === 'win32' ? 'claude.cmd' : 'claude'),
    defaultCwd,
    allowedCwdPrefixes: [defaultCwd],
    permissionMode: 'default',
    model: null,
    reasoningEffort: null,
    extraArgs: [],
    ...local,
    ...options.overrides,
  })
  return { shared, sharedFile, config }
}

export async function createCc2Server(options = {}) {
  const loaded = await loadConfig(options)
  const logger = options.logger ?? new Logger('cc2server', loaded.config.logLevel)
  const adapter = await new ClaudeAdapter(loaded.config, { logger, configDir: dirname(loaded.sharedFile) }).init()
  const client = new RelayClient({ config: loaded.config, adapter, logger, version: VERSION })
  return { ...loaded, logger, adapter, client }
}

export { ClaudeAdapter, RelayClient }
