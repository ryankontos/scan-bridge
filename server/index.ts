import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import multer from 'multer'
import { nanoid } from 'nanoid'
import * as ws from 'ws'

import { runOcr } from './ocr.js'
import type { OcrProfile, RegexPresetId, ScanPayload, SessionStatus } from '../src/types.js'

const { WebSocketServer } = ws
type WebSocket = ws.WebSocket

type SessionRecord = {
  id: string
  desktopClients: Set<WebSocket>
  mobileClients: Set<WebSocket>
  lastActivityAt: string | null
  createdAt: number
  ocrProfile: OcrProfile
  lastScan: ScanPayload | null
  pendingScan: ScanPayload | null
  regex: string
  regexPresetId: RegexPresetId
  reviewBeforeSend: boolean
}

type SocketRole = 'desktop' | 'mobile'
type TrackedWebSocket = WebSocket & {
  isAlive?: boolean
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const distDir = join(rootDir, 'dist')

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'))
  },
})

const sessions = new Map<string, SessionRecord>()
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const port = Number(process.env.PORT ?? 8787)
const DEFAULT_REGEX = '\\b[A-Z0-9]{8,12}\\b'

function getOcrProfileForPreset(presetId: RegexPresetId): OcrProfile {
  switch (presetId) {
    case 'macSerial':
      return 'macSerial'
    case 'appleModel':
      return 'appleModel'
    default:
      return 'generic'
  }
}

function createSession() {
  const id = nanoid(12)
  const session: SessionRecord = {
    id,
    desktopClients: new Set(),
    mobileClients: new Set(),
    lastActivityAt: null,
    createdAt: Date.now(),
    ocrProfile: 'macSerial',
    lastScan: null,
    pendingScan: null,
    regex: DEFAULT_REGEX,
    regexPresetId: 'macSerial',
    reviewBeforeSend: false,
  }
  sessions.set(id, session)
  return session
}

function getSessionStatus(session: SessionRecord): SessionStatus {
  return {
    sessionId: session.id,
    desktopConnected: session.desktopClients.size > 0,
    mobileConnected: session.mobileClients.size > 0,
    desktopCount: session.desktopClients.size,
    mobileCount: session.mobileClients.size,
    lastActivityAt: session.lastActivityAt,
    ocrProfile: session.ocrProfile,
    latestScanId: session.lastScan?.id ?? null,
    latestPendingScanId: session.pendingScan?.id ?? null,
    regex: session.regex,
    regexPresetId: session.regexPresetId,
    reviewBeforeSend: session.reviewBeforeSend,
  }
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

function broadcastStatus(session: SessionRecord) {
  const payload = { type: 'status', payload: getSessionStatus(session) }
  for (const socket of session.desktopClients) {
    send(socket, payload)
  }
  for (const socket of session.mobileClients) {
    send(socket, payload)
  }
}

function touchSession(session: SessionRecord) {
  session.lastActivityAt = new Date().toISOString()
}

function closeAndDeleteSession(id: string) {
  const session = sessions.get(id)
  if (!session) {
    return
  }

  for (const socket of session.desktopClients) {
    socket.close(1000, 'Session reset')
  }
  for (const socket of session.mobileClients) {
    socket.close(1000, 'Session reset')
  }

  sessions.delete(id)
}

setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions.entries()) {
    if (
      session.desktopClients.size === 0 &&
      session.mobileClients.size === 0 &&
      now - session.createdAt > SESSION_TTL_MS
    ) {
      sessions.delete(id)
    }
  }
}, 60_000).unref()

app.disable('x-powered-by')
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/session', (_req, res) => {
  const session = createSession()
  res.json({ sessionId: session.id })
})

app.get('/api/session/:sessionId/status', (req, res) => {
  const sessionId = String(req.params.sessionId)
  const session = sessions.get(sessionId)

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  res.json(getSessionStatus(session))
})

app.get('/api/session/:sessionId/latest-scan', (req, res) => {
  const session = sessions.get(String(req.params.sessionId))

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  if (!session.lastScan) {
    res.status(204).end()
    return
  }

  res.json(session.lastScan)
})

app.get('/api/session/:sessionId/pending-scan', (req, res) => {
  const session = sessions.get(String(req.params.sessionId))

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  if (!session.pendingScan) {
    res.status(204).end()
    return
  }

  res.json(session.pendingScan)
})

app.delete('/api/session/:sessionId', (req, res) => {
  closeAndDeleteSession(String(req.params.sessionId))
  res.status(204).end()
})

app.put('/api/session/:sessionId/config', (req, res) => {
  const session = sessions.get(String(req.params.sessionId))

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  const nextRegex = typeof req.body?.regex === 'string' ? req.body.regex : undefined
  if (typeof nextRegex === 'string') {
    try {
      if (nextRegex.trim()) {
        new RegExp(nextRegex)
      }
    } catch {
      res.status(400).json({ error: 'Invalid regex' })
      return
    }
    session.regex = nextRegex
  }

  const nextPresetId = req.body?.regexPresetId as RegexPresetId | undefined
  if (nextPresetId && !['macSerial', 'appleModel', 'custom'].includes(nextPresetId)) {
    res.status(400).json({ error: 'Invalid regex preset' })
    return
  }

  if (nextPresetId) {
    session.regexPresetId = nextPresetId
    session.ocrProfile = getOcrProfileForPreset(nextPresetId)
  }

  if (typeof req.body?.reviewBeforeSend === 'boolean') {
    session.reviewBeforeSend = req.body.reviewBeforeSend
  }

  broadcastStatus(session)
  res.json(getSessionStatus(session))
})

app.post('/api/session/:sessionId/scan', upload.single('image'), async (req, res) => {
  const session = sessions.get(String(req.params.sessionId))

  if (!session) {
    res.status(404).json({ error: 'Session not found. Reset the desktop link and re-pair.' })
    return
  }

  if (!req.file?.buffer) {
    res.status(400).json({ error: 'No image uploaded.' })
    return
  }

  try {
    const result = await runOcr(req.file.buffer, session.ocrProfile)
    touchSession(session)

    const payload = {
      id: nanoid(10),
      sessionId: session.id,
      receivedAt: session.lastActivityAt ?? new Date().toISOString(),
      text: result.text,
      normalizedText: result.normalizedText,
    }
    if (session.reviewBeforeSend) {
      session.pendingScan = payload
      const previewEvent = { type: 'preview', payload }
      for (const socket of session.mobileClients) {
        send(socket, previewEvent)
      }
    } else {
      session.pendingScan = null
      session.lastScan = payload
      const event = { type: 'scan', payload }

      for (const socket of session.desktopClients) {
        send(socket, event)
      }

      for (const socket of session.mobileClients) {
        send(socket, event)
      }
    }

    broadcastStatus(session)
    res.json({
      mode: session.reviewBeforeSend ? 'preview' : 'sent',
      payload,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OCR failed'
    res.status(500).json({ error: message })
  }
})

app.post('/api/session/:sessionId/confirm-pending', (req, res) => {
  const session = sessions.get(String(req.params.sessionId))

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  if (!session.pendingScan) {
    res.status(404).json({ error: 'No pending scan' })
    return
  }

  const payload = session.pendingScan
  session.pendingScan = null
  session.lastScan = payload
  const event = { type: 'scan', payload }

  for (const socket of session.desktopClients) {
    send(socket, event)
  }

  for (const socket of session.mobileClients) {
    send(socket, event)
  }

  broadcastStatus(session)
  res.json(payload)
})

app.delete('/api/session/:sessionId/pending-scan', (req, res) => {
  const session = sessions.get(String(req.params.sessionId))

  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  session.pendingScan = null
  broadcastStatus(session)
  res.status(204).end()
})

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distDir))
  app.get(/.*/, (_req, res) => {
    res.sendFile(join(distDir, 'index.html'))
  })
}

wss.on('connection', (socket, request) => {
  const trackedSocket = socket as TrackedWebSocket
  trackedSocket.isAlive = true

  const url = new URL(request.url ?? '', `http://${request.headers.host}`)
  const sessionId = url.searchParams.get('sessionId')
  const role = url.searchParams.get('role') as SocketRole | null

  if (!sessionId || (role !== 'desktop' && role !== 'mobile')) {
    send(socket, { type: 'error', message: 'Invalid socket session' })
    socket.close(1008, 'Invalid socket session')
    return
  }

  const session = sessions.get(sessionId)
  if (!session) {
    send(socket, { type: 'error', message: 'Session not found' })
    socket.close(1008, 'Session not found')
    return
  }

  const bucket = role === 'desktop' ? session.desktopClients : session.mobileClients
  bucket.add(socket)
  socket.on('pong', () => {
    trackedSocket.isAlive = true
  })
  send(socket, { type: 'status', payload: getSessionStatus(session) })
  if (session.lastScan) {
    send(socket, { type: 'scan', payload: session.lastScan })
  }
  if (role === 'mobile' && session.pendingScan) {
    send(socket, { type: 'preview', payload: session.pendingScan })
  }
  broadcastStatus(session)

  socket.on('close', () => {
    bucket.delete(socket)
    broadcastStatus(session)
  })
})

setInterval(() => {
  for (const client of wss.clients) {
    const trackedClient = client as TrackedWebSocket

    if (trackedClient.isAlive === false) {
      client.terminate()
      continue
    }

    trackedClient.isAlive = false
    if (client.readyState === client.OPEN) {
      send(client, { type: 'heartbeat', at: new Date().toISOString() })
      client.ping()
    }
  }
}, 15_000).unref()

server.listen(port, () => {
  console.log(`Scan Bridge server listening on http://localhost:${port}`)
})
