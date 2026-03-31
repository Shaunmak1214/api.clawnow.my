import { Writable } from 'node:stream'
import { inspect } from 'node:util'

import pino from 'pino'

type ConsoleMethod = (...args: unknown[]) => void

type OriginalConsole = {
  log: ConsoleMethod
  error: ConsoleMethod
  warn: ConsoleMethod
  info: ConsoleMethod
  debug: ConsoleMethod
}

const globalState = globalThis as typeof globalThis & {
  originalConsole?: OriginalConsole
}

const serviceName = 'clawnow-api'
const nodeEnv = process.env.NODE_ENV || 'development'

function isLokiEnabled() {
  return process.env.ENABLE_LOKI === 'true' || process.env.ENABLE_LOKI === '1'
}

function getLokiUrl() {
  if (!isLokiEnabled()) {
    return null
  }

  const lokiUrl = process.env.LOKI_INTERNAL_URL || process.env.LOKI_URL
  if (!lokiUrl) {
    return null
  }

  if (lokiUrl.includes('${{') || lokiUrl.includes('{{')) {
    return null
  }

  return lokiUrl
}

function formatArgs(args: unknown[]) {
  return args
    .map((arg) => {
      if (typeof arg === 'string') {
        return arg
      }

      if (arg && typeof arg === 'object' && 'stack' in arg && typeof arg.stack === 'string') {
        return arg.stack
      }

      try {
        return inspect(arg, { depth: null, colors: false })
      } catch {
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      }
    })
    .join(' ')
}

const isCallerEnabled = process.env.LOG_CALLER !== 'false' && process.env.LOG_CALLER !== '0'

function getCaller() {
  if (!isCallerEnabled) {
    return null
  }

  try {
    const stack = new Error().stack
    if (!stack) {
      return null
    }

    const lines = stack.split('\n')
    const root = process.cwd()

    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.includes('logger.ts')) continue
      if (line.includes('node_modules')) continue
      if (line.includes('node:')) continue

      const match = line.match(/at\s+(?:(.+?)\s+\()?(.*?):(\d+):\d+\)?/)
      if (!match) {
        continue
      }

      let file = match[2] || 'unknown'
      const func = match[1] || 'anonymous'
      const lineNum = match[3] || '0'

      if (file.startsWith('file://')) {
        file = file.slice(7)
      }

      if (file.startsWith(root)) {
        file = file.slice(root.length + 1)
      }

      return {
        file,
        func,
        line: lineNum,
      }
    }
  } catch {
    return null
  }

  return null
}

function buildPrefix(level: string) {
  try {
    const caller = getCaller()
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 23)
    const callerLabel = caller
      ? `${caller.file}:${caller.line}${caller.func !== 'anonymous' ? ` ${caller.func}` : ''}`
      : 'unknown'

    return `[${timestamp}] ${level.padEnd(5)} [${callerLabel}]`
  } catch {
    return ''
  }
}

function getCallerMeta() {
  try {
    const caller = getCaller()
    if (!caller) {
      return {}
    }

    return {
      caller: `${caller.file}:${caller.line}${caller.func !== 'anonymous' ? ` ${caller.func}` : ''}`,
    }
  } catch {
    return {}
  }
}

class LokiStream extends Writable {
  private readonly lokiUrl: string
  private readonly labels: Record<string, string>
  private readonly buffer: Array<Record<string, unknown>> = []
  private readonly batchSize = 100
  private readonly flushInterval = 5000
  private readonly intervalId: NodeJS.Timeout

  constructor(lokiUrl: string, labels: Record<string, string> = {}) {
    super({ objectMode: false })
    this.lokiUrl = lokiUrl
    this.labels = labels
    this.intervalId = setInterval(() => {
      void this.flush()
    }, this.flushInterval)
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    try {
      const logLine = chunk.toString()
      const logEntry = JSON.parse(logLine) as Record<string, unknown>
      this.buffer.push(logEntry)

      if (this.buffer.length >= this.batchSize) {
        void this.flush()
      }

      callback()
    } catch {
      callback()
    }
  }

  override _final(callback: (error?: Error | null) => void) {
    void this.flush().finally(() => {
      clearInterval(this.intervalId)
      callback()
    })
  }

  async flush() {
    if (this.buffer.length === 0) {
      return
    }

    const logsToSend = [...this.buffer]
    this.buffer.length = 0

    try {
      const streamMap = new Map<string, { stream: Record<string, string>; values: string[][] }>()

      for (const log of logsToSend) {
        const labels: Record<string, string> = {
          ...this.labels,
          level: typeof log.level === 'string' ? log.level : 'info',
        }

        if (typeof log.service === 'string') {
          labels.service = log.service
        }

        if (typeof log.env === 'string') {
          labels.environment = log.env
        }

        const key = JSON.stringify(labels)
        if (!streamMap.has(key)) {
          streamMap.set(key, {
            stream: labels,
            values: [],
          })
        }

        let message = typeof log.msg === 'string' ? log.msg : ''

        if (log.err) {
          const errObj = typeof log.err === 'string' ? { message: log.err } : log.err
          message += `\nError: ${formatArgs([errObj])}`
        }

        if (typeof log.message === 'string' && log.message !== log.msg) {
          message += `\n${log.message}`
        }

        const { level, time, msg, err, message: messageField, service, env, pid, hostname, ...rest } = log
        if (Object.keys(rest).length > 0) {
          message += `\n${JSON.stringify(rest)}`
        }

        const timeValue =
          typeof time === 'string'
            ? new Date(time).getTime()
            : typeof time === 'number'
              ? time
              : Date.now()

        streamMap.get(key)?.values.push([String(timeValue * 1_000_000), message])
      }

      const payload = {
        streams: Array.from(streamMap.values()),
      }

      await fetch(`${this.lokiUrl}/loki/api/v1/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
    } catch (error) {
      if (process.env.DEBUG_LOKI === 'true' || process.env.DEBUG_LOKI === '1') {
        globalState.originalConsole?.error('Failed to send logs to Loki:', error)
      }
    }
  }
}

function createLogger() {
  const lokiUrl = getLokiUrl()
  const config: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      env: nodeEnv,
      service: serviceName,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  }

  if (lokiUrl && nodeEnv !== 'TESTING') {
    try {
      const lokiStream = new LokiStream(lokiUrl, {
        job: serviceName,
        environment: nodeEnv,
      })

      const streams = pino.multistream([
        { stream: process.stdout, level: 'info' },
        { stream: lokiStream, level: 'info' },
      ])

      return pino(config, streams)
    } catch {
      return pino(config)
    }
  }

  if (nodeEnv === 'TESTING' || nodeEnv === 'development') {
    return pino(
      config,
      pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      }),
    )
  }

  return pino(config)
}

export const logger = createLogger()

globalState.originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
}

const shouldUseLoki = Boolean(isLokiEnabled() && getLokiUrl() && nodeEnv !== 'TESTING')
const isSuppressEnabled = process.env.LOG_SUPPRESS !== 'false' && process.env.LOG_SUPPRESS !== '0'

const suppressPatterns = [
  'Closing open session',
  'Decrypted message with closed session',
  'SessionEntry',
  'Failed to decrypt message with any known session',
  'Session error:Error: Bad MAC',
  'Bad MAC Error: Bad MAC',
  'at Object.verifyMAC',
  'at SessionCipher.doDecryptWhisperMessage',
  'at async SessionCipher.decryptWithSessions',
  'at async _asyncQueueExecutor',
  'libsignal/src/crypto.js',
  'libsignal/src/session_cipher.js',
  'libsignal/src/queue_job.js',
]

function shouldSuppress(message: string) {
  if (!isSuppressEnabled) {
    return false
  }

  try {
    return suppressPatterns.some((pattern) => message.includes(pattern))
  } catch {
    return false
  }
}

function forwardConsole(level: 'info' | 'error' | 'warn' | 'debug', args: unknown[]) {
  const message = formatArgs(args)
  if (shouldSuppress(message)) {
    return
  }

  if (shouldUseLoki) {
    const meta = getCallerMeta()
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
      logger[level]({ ...meta, ...(args[0] as Record<string, unknown>) })
      return
    }

    if (level === 'error') {
      const errorMessage =
        args[0] && typeof args[0] === 'object' && 'stack' in (args[0] as Record<string, unknown>)
          ? String((args[0] as Record<string, unknown>).stack)
          : message
      logger.error({ ...meta, message: errorMessage, error: errorMessage })
      return
    }

    logger[level]({ ...meta, message })
    return
  }

  const prefix = buildPrefix(level.toUpperCase())
  const target = globalState.originalConsole?.[level === 'debug' ? 'debug' : level] || global.console[level]
  target(prefix ? prefix : '', ...args)
}

console.log = (...args: unknown[]) => forwardConsole('info', args)
console.info = (...args: unknown[]) => forwardConsole('info', args)
console.warn = (...args: unknown[]) => forwardConsole('warn', args)
console.error = (...args: unknown[]) => forwardConsole('error', args)
console.debug = (...args: unknown[]) => forwardConsole('debug', args)

const originalStdoutWrite = process.stdout.write.bind(process.stdout)
const originalStderrWrite = process.stderr.write.bind(process.stderr)

process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
  try {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    if (shouldSuppress(text)) {
      if (typeof encoding === 'function') {
        encoding()
        return true
      }
      if (callback) {
        callback()
      }
      return true
    }
  } catch {
    // never block stdout
  }

  return originalStdoutWrite(chunk as never, encoding as never, callback as never)
}) as typeof process.stdout.write

process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
  try {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    if (shouldSuppress(text)) {
      if (typeof encoding === 'function') {
        encoding()
        return true
      }
      if (callback) {
        callback()
      }
      return true
    }
  } catch {
    // never block stderr
  }

  return originalStderrWrite(chunk as never, encoding as never, callback as never)
}) as typeof process.stderr.write

export default logger
