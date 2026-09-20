#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createCc2Server, loadConfig, VERSION } from '../index.js'
import { replaceFilePortable } from '../lib/a2s/shared-config.js'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { command, options } = parseArgs(process.argv.slice(2))

try {
  if (command === 'doctor') await doctor()
  else if (command === 'config') await showConfig()
  else if (command === 'status') await showStatus()
  else if (command === 'start') await start()
  else usage(1)
} catch (error) {
  console.error(`[cc2server] ${error?.stack || error}`)
  process.exitCode = 1
}

async function start() {
  const app = await createCc2Server(options)
  if (!app.config.enabled) {
    console.log('[cc2server] disabled in the shared A2S config')
    return
  }
  const runtimeFile = join(dirname(app.sharedFile), 'runtime', 'claude.json')
  let writeTimer
  let writeChain = Promise.resolve()
  const queueStatus = (document) => {
    writeChain = writeChain
      .then(() => atomicJson(runtimeFile, document))
      .catch((error) => app.logger.warn(`cannot persist runtime status: ${error.message}`))
    return writeChain
  }
  const writeStatus = (status = app.client.status()) => {
    clearTimeout(writeTimer)
    const document = {
      version: 1,
      plugin: 'cc2server',
      pluginVersion: VERSION,
      installPath: PLUGIN_ROOT,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      running: true,
      ...status,
    }
    writeTimer = setTimeout(() => void queueStatus(document), 25)
  }
  app.client.on('status', writeStatus)
  app.client.start()
  writeStatus()
  const statusTimer = setInterval(() => writeStatus(), 30000)

  const shutdown = async (signal) => {
    app.logger.info(`received ${signal}, shutting down`)
    app.client.off('status', writeStatus)
    clearTimeout(writeTimer)
    clearInterval(statusTimer)
    await writeChain
    await app.client.close(signal)
    await atomicJson(runtimeFile, { version: 1, plugin: 'cc2server', pluginVersion: VERSION, installPath: PLUGIN_ROOT, pid: process.pid, running: false, connected: false, stoppedAt: new Date().toISOString() })
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGHUP', () => void shutdown('SIGHUP'))
}

async function doctor() {
  const loaded = await loadConfig(options)
  const result = await commandOutput(loaded.config.executable, ['--version'])
  const report = {
    ok: result.code === 0,
    plugin: 'cc2server',
    pluginVersion: VERSION,
    node: process.version,
    configFile: loaded.sharedFile,
    instanceId: loaded.config.instanceId,
    locale: loaded.config.locale,
    resolvedLocale: loaded.config.resolvedLocale,
    keyFingerprint: fingerprint(loaded.config.key),
    endpoints: loaded.config.endpoints,
    executable: loaded.config.executable,
    claudeVersion: result.stdout.trim() || result.stderr.trim(),
    cwd: loaded.config.defaultCwd,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

async function showConfig() {
  const loaded = await loadConfig(options)
  console.log(JSON.stringify({ ...loaded.config, key: fingerprint(loaded.config.key), sharedConfigFile: loaded.sharedFile }, null, 2))
}

async function showStatus() {
  const loaded = await loadConfig(options)
  const file = join(dirname(loaded.sharedFile), 'runtime', 'claude.json')
  try { console.log(await readFile(file, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') console.log(JSON.stringify({ running: false, connected: false }, null, 2))
    else throw error
  }
}

function commandOutput(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: process.platform === 'win32' && !/\.exe$/i.test(command) })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }))
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await replaceFilePortable(temporary, file)
}

function parseArgs(args) {
  let command = 'start'
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]
    if (!value.startsWith('-') && i === 0) command = value
    else if (value === '--config') options.configFile = args[++i]
    else if (value === '--shared-config') options.sharedConfigFile = args[++i]
    else if (value === '--locale') options.overrides = { ...(options.overrides || {}), locale: args[++i] }
    else if (value === '--help' || value === '-h') usage(0)
    else if (value === '--version' || value === '-v') { console.log(VERSION); process.exit(0) }
    else throw new Error(`unknown option ${value}`)
  }
  return { command, options }
}

function fingerprint(key) { return key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-4)}` : '***' }

function usage(code) {
  console.log('Usage: cc2server [start|doctor|config|status] [--shared-config FILE] [--config FILE] [--locale system|zh-CN|en-US]')
  process.exit(code)
}
