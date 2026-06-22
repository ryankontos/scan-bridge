import { Camera, Link2, Moon, RefreshCw, ScanLine, Sun, Trash2, Upload } from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'
import { Separator } from './components/ui/separator'
import { extractPresetMatch } from './lib/scan-extract'
import type { OcrProfile, RegexPresetId, ScanPayload, SessionConfig, SessionStatus } from './types'

type ScanRecord = ScanPayload & {
  extracted: string | null
}

type ObserverPayload = {
  sessionId: string | null
  regex: string
  regexPresetId: RegexPresetId
  latestScanId: string | null
  latestExtracted: string
  latestNormalizedText: string
  latestRawText: string
  updatedAt: string | null
}

type ServerEvent =
  | { type: 'status'; payload: SessionStatus }
  | { type: 'scan'; payload: ScanPayload }
  | { type: 'preview'; payload: ScanPayload }
  | { type: 'heartbeat'; at: string }
  | { type: 'error'; message: string }

type SocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline'
type ConnectionState = 'not connected' | 'disconnected' | 'connected'
type ThemeMode = 'light' | 'dark'
type UploadQuality = 'fast' | 'balanced' | 'full'

const HISTORY_KEY = 'scan-bridge-history'
const SESSION_KEY = 'scan-bridge-session'
const REGEX_KEY = 'scan-bridge-regex'
const REGEX_PRESET_KEY = 'scan-bridge-regex-preset'
const REVIEW_MODE_KEY = 'scan-bridge-review-before-send'
const OBSERVER_KEY = 'scan-bridge-observer'
const THEME_KEY = 'scan-bridge-theme'
const REGEX_PRESETS: Array<{ id: RegexPresetId; label: string; pattern: string }> = [
  { id: 'macSerial', label: 'Mac serial number', pattern: '\\b[A-Z0-9]{8,12}\\b' },
  { id: 'appleModel', label: 'Apple A-number', pattern: '\\bA\\d{4}\\b' },
  { id: 'custom', label: 'Custom pattern', pattern: '' },
]

declare global {
  interface Window {
    __scanBridgeObserver?: ObserverPayload
  }
}

function detectPresetId(pattern: string): RegexPresetId {
  const preset = REGEX_PRESETS.find((item) => item.id !== 'custom' && item.pattern === pattern)
  return preset?.id ?? 'custom'
}

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

function buildSessionConfig(regex: string, regexPresetId: RegexPresetId, reviewBeforeSend: boolean): SessionConfig {
  return { regex, regexPresetId, reviewBeforeSend }
}

async function pushSessionConfig(sessionId: string, config: SessionConfig) {
  await fetch(`/api/session/${sessionId}/config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      regex: config.regex,
      regexPresetId: config.regexPresetId,
      reviewBeforeSend: config.reviewBeforeSend,
      ocrProfile: getOcrProfileForPreset(config.regexPresetId),
    }),
  })
}

function formatTime(value: string | null) {
  if (!value) {
    return 'No activity yet'
  }

  return new Date(value).toLocaleString()
}

function normalizeClientText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function getVisibleSocketError(error: string | null) {
  if (!error || error === 'Link closed' || error === 'Session not found') {
    return null
  }

  return error
}

async function optimizeImageForUpload(file: Blob, quality: UploadQuality) {
  if (quality === 'full') {
    return file
  }

  const image = await createImageBitmap(file)
  const maxLongEdge = quality === 'fast' ? 1200 : 1600
  const longEdge = Math.max(image.width, image.height)
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    image.close()
    throw new Error('Canvas optimization unavailable')
  }

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  image.close()

  const optimizedBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality === 'fast' ? 0.66 : 0.8)
  })

  if (!optimizedBlob) {
    throw new Error('Image optimization failed')
  }

  return optimizedBlob
}

function AppearanceToggle({
  theme,
  onToggle,
}: {
  theme: ThemeMode
  onToggle: () => void
}) {
  return (
    <Button variant="outline" size="sm" onClick={onToggle} aria-label="Toggle appearance">
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  )
}

function connectionStateFromSocket(socketState: SocketState, hasConnectedBefore: boolean): ConnectionState {
  if (socketState === 'connected') {
    return 'connected'
  }

  if (hasConnectedBefore || socketState === 'reconnecting' || socketState === 'offline') {
    return 'disconnected'
  }

  return 'not connected'
}

function connectionStateFromPeer(connectedNow: boolean, hasConnectedBefore: boolean): ConnectionState {
  if (connectedNow) {
    return 'connected'
  }

  if (hasConnectedBefore) {
    return 'disconnected'
  }

  return 'not connected'
}

function useSessionSocket(
  sessionId: string | null,
  role: 'desktop' | 'mobile',
  onScan?: (scan: ScanPayload) => void,
) {
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [lastScan, setLastScan] = useState<ScanPayload | null>(null)
  const [pendingScan, setPendingScan] = useState<ScanPayload | null>(null)
  const [socketError, setSocketError] = useState<string | null>(null)
  const [socketState, setSocketState] = useState<SocketState>('idle')
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false)
  const [hasPeerConnectedOnce, setHasPeerConnectedOnce] = useState(false)
  const socketStateRef = useRef<SocketState>('idle')
  const lastScanIdRef = useRef<string | null>(null)
  const pendingScanIdRef = useRef<string | null>(null)
  const latestFetchRef = useRef<string | null>(null)
  const pendingFetchRef = useRef<string | null>(null)
  const handleScan = useEffectEvent((scan: ScanPayload) => {
    onScan?.(scan)
  })
  const applyIncomingScan = useEffectEvent((scan: ScanPayload) => {
    lastScanIdRef.current = scan.id
    latestFetchRef.current = null
    pendingScanIdRef.current = null
    pendingFetchRef.current = null
    setPendingScan(null)
    setLastScan((current) => (current?.id === scan.id ? current : scan))
    handleScan(scan)
  })
  const applyIncomingPreview = useEffectEvent((scan: ScanPayload) => {
    pendingScanIdRef.current = scan.id
    pendingFetchRef.current = null
    setPendingScan((current) => (current?.id === scan.id ? current : scan))
  })

  useEffect(() => {
    socketStateRef.current = socketState
  }, [socketState])

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setStatus(null)
      setLastScan(null)
      setPendingScan(null)
      setSocketError(null)
      setSocketState(sessionId ? 'connecting' : 'idle')
      setHasConnectedOnce(false)
      setHasPeerConnectedOnce(false)
      lastScanIdRef.current = null
      latestFetchRef.current = null
      pendingScanIdRef.current = null
      pendingFetchRef.current = null
    }, 0)

    if (!sessionId) {
      return () => {
        window.clearTimeout(resetTimer)
      }
    }

    let cancelled = false
    let socket: WebSocket | null = null
    let retryTimer: number | null = null
    let pollTimer: number | null = null
    let reconnectAttempt = 0

    const fetchLatestScan = async (expectedScanId?: string | null) => {
      if (latestFetchRef.current && latestFetchRef.current === expectedScanId) {
        return
      }

      latestFetchRef.current = expectedScanId ?? '__latest__'

      try {
        const response = await fetch(`/api/session/${sessionId}/latest-scan`, { cache: 'no-store' })
        if (response.status === 204 || !response.ok) {
          if (latestFetchRef.current === (expectedScanId ?? '__latest__')) {
            latestFetchRef.current = null
          }
          return
        }

        const payload = (await response.json()) as ScanPayload
        if (!cancelled) {
          applyIncomingScan(payload)
        }
      } catch {
        if (latestFetchRef.current === (expectedScanId ?? '__latest__')) {
          latestFetchRef.current = null
        }
      }
    }

    const fetchPendingScan = async (expectedPendingId?: string | null) => {
      if (pendingFetchRef.current && pendingFetchRef.current === expectedPendingId) {
        return
      }

      pendingFetchRef.current = expectedPendingId ?? '__pending__'

      try {
        const response = await fetch(`/api/session/${sessionId}/pending-scan`, { cache: 'no-store' })
        if (response.status === 204) {
          pendingScanIdRef.current = null
          setPendingScan(null)
          if (pendingFetchRef.current === (expectedPendingId ?? '__pending__')) {
            pendingFetchRef.current = null
          }
          return
        }

        if (!response.ok) {
          if (pendingFetchRef.current === (expectedPendingId ?? '__pending__')) {
            pendingFetchRef.current = null
          }
          return
        }

        const payload = (await response.json()) as ScanPayload
        if (!cancelled) {
          applyIncomingPreview(payload)
        }
      } catch {
        if (pendingFetchRef.current === (expectedPendingId ?? '__pending__')) {
          pendingFetchRef.current = null
        }
      }
    }

    const fetchStatus = async () => {
      try {
        const response = await fetch(`/api/session/${sessionId}/status`, { cache: 'no-store' })
        if (!response.ok) {
          if (response.status === 404) {
            setSocketError('Session not found')
            setSocketState('offline')
          }
          return
        }

        const payload = (await response.json()) as SessionStatus
        if (!cancelled) {
          setStatus(payload)
          const peerConnected = role === 'desktop' ? payload.mobileConnected : payload.desktopConnected
          if (peerConnected) {
            setHasPeerConnectedOnce(true)
          }

          if (payload.latestScanId && payload.latestScanId !== lastScanIdRef.current) {
            void fetchLatestScan(payload.latestScanId)
          }
          if (payload.latestPendingScanId && payload.latestPendingScanId !== pendingScanIdRef.current) {
            void fetchPendingScan(payload.latestPendingScanId)
          }
          if (!payload.latestPendingScanId) {
            pendingScanIdRef.current = null
            pendingFetchRef.current = null
            setPendingScan(null)
          }
        }
      } catch {
        if (!cancelled && socketStateRef.current !== 'connected') {
          setSocketError('Status check failed')
        }
      }
    }

    const scheduleReconnect = () => {
      if (cancelled) {
        return
      }

      reconnectAttempt += 1
      setSocketState('reconnecting')
      const delayMs = Math.min(1000 * reconnectAttempt, 5000)
      retryTimer = window.setTimeout(connect, delayMs)
    }

    const connect = () => {
      if (cancelled) {
        return
      }

      setSocketState(reconnectAttempt > 0 ? 'reconnecting' : 'connecting')
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(
        `${protocol}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}&role=${role}`,
      )

      socket.onopen = () => {
        reconnectAttempt = 0
        setSocketError(null)
        setSocketState('connected')
        setHasConnectedOnce(true)
      }

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as ServerEvent

        if (data.type === 'status') {
          setStatus(data.payload)
          setSocketError(null)
          const peerConnected = role === 'desktop' ? data.payload.mobileConnected : data.payload.desktopConnected
          if (peerConnected) {
            setHasPeerConnectedOnce(true)
          }

          if (data.payload.latestScanId && data.payload.latestScanId !== lastScanIdRef.current) {
            void fetchLatestScan(data.payload.latestScanId)
          }
          if (data.payload.latestPendingScanId && data.payload.latestPendingScanId !== pendingScanIdRef.current) {
            void fetchPendingScan(data.payload.latestPendingScanId)
          }
          if (!data.payload.latestPendingScanId) {
            pendingScanIdRef.current = null
            pendingFetchRef.current = null
            setPendingScan(null)
          }
        }

        if (data.type === 'scan') {
          applyIncomingScan(data.payload)
        }

        if (data.type === 'preview') {
          applyIncomingPreview(data.payload)
        }

        if (data.type === 'heartbeat') {
          setSocketError(null)
        }

        if (data.type === 'error') {
          setSocketError(data.message)
        }
      }

      socket.onclose = () => {
        if (cancelled) {
          return
        }

        setSocketError('Link closed')
        scheduleReconnect()
      }

      socket.onerror = () => {
        if (cancelled) {
          return
        }

        setSocketError('Link error')
        setSocketState('offline')
      }
    }

    void fetchStatus()
    pollTimer = window.setInterval(() => {
      void fetchStatus()
    }, 1200)
    connect()

    return () => {
      cancelled = true
      window.clearTimeout(resetTimer)
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
      }
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
      }
      socket?.close()
    }
  }, [role, sessionId])

  return { status, lastScan, pendingScan, socketError, socketState, hasConnectedOnce, hasPeerConnectedOnce }
}

function DesktopPage({
  theme,
  onToggleTheme,
}: {
  theme: ThemeMode
  onToggleTheme: () => void
}) {
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(SESSION_KEY))
  const [history, setHistory] = useState<ScanRecord[]>(() => {
    const raw = localStorage.getItem(HISTORY_KEY)
    return raw ? (JSON.parse(raw) as ScanRecord[]) : []
  })
  const [regex, setRegex] = useState(() => localStorage.getItem(REGEX_KEY) ?? '\\b[A-Z0-9]{8,12}\\b')
  const [regexPresetId, setRegexPresetId] = useState<RegexPresetId>(() => {
    const storedPreset = localStorage.getItem(REGEX_PRESET_KEY) as RegexPresetId | null
    if (storedPreset && REGEX_PRESETS.some((preset) => preset.id === storedPreset)) {
      return storedPreset
    }

    return detectPresetId(localStorage.getItem(REGEX_KEY) ?? '\\b[A-Z0-9]{8,12}\\b')
  })
  const [regexError, setRegexError] = useState<string | null>(null)
  const [reviewBeforeSend, setReviewBeforeSend] = useState(() => localStorage.getItem(REVIEW_MODE_KEY) === 'true')
  const [qrCode, setQrCode] = useState('')
  const [loadingSession, setLoadingSession] = useState(false)
  const regexRef = useRef(regex)
  const regexPresetIdRef = useRef(regexPresetId)
  const latestScan = history[0] ?? null

  function appendScan(scan: ScanPayload) {
    setHistory((current) => {
      if (current[0]?.id === scan.id) {
        return current
      }

      const extracted = extractPresetMatch(scan, regexPresetIdRef.current, regexRef.current)
      return [{ ...scan, extracted }, ...current].slice(0, 100)
    })
  }

  function rebuildHistoryForConfig(nextRegex: string, nextPresetId: RegexPresetId) {
    setHistory((current) =>
      current.map((scan) => ({
        ...scan,
        extracted: extractPresetMatch(scan, nextPresetId, nextRegex),
      })),
    )
  }

  const { status, pendingScan, socketError, socketState, hasPeerConnectedOnce } = useSessionSocket(sessionId, 'desktop', appendScan)

  async function syncConfig(nextConfig: SessionConfig, targetSessionId = sessionId) {
    if (!targetSessionId) return
    await pushSessionConfig(targetSessionId, nextConfig)
  }

  async function ensureSession(reset = false) {
    setLoadingSession(true)

    try {
      if (reset && sessionId) {
        await fetch(`/api/session/${sessionId}`, { method: 'DELETE' })
      }

      const response = await fetch('/api/session', { method: 'POST' })
      const payload = (await response.json()) as { sessionId: string }
      setSessionId(payload.sessionId)
      await syncConfig(buildSessionConfig(regexRef.current, regexPresetId, reviewBeforeSend), payload.sessionId)
    } finally {
      setLoadingSession(false)
    }
  }

  async function bootstrapSession() {
    if (!sessionId) {
      await ensureSession()
      return
    }

    setLoadingSession(true)

    try {
      const response = await fetch(`/api/session/${sessionId}/status`)
      if (response.ok) {
        return
      }

      const createResponse = await fetch('/api/session', { method: 'POST' })
      const payload = (await createResponse.json()) as { sessionId: string }
      setSessionId(payload.sessionId)
    } finally {
      setLoadingSession(false)
    }
  }

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  }, [history])

  useEffect(() => {
    if (sessionId) {
      localStorage.setItem(SESSION_KEY, sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    localStorage.setItem(REGEX_KEY, regex)
    localStorage.setItem(REGEX_PRESET_KEY, regexPresetId)
    localStorage.setItem(REVIEW_MODE_KEY, String(reviewBeforeSend))
  }, [regex, regexPresetId, reviewBeforeSend])

  useEffect(() => {
    regexRef.current = regex
  }, [regex])

  useEffect(() => {
    regexPresetIdRef.current = regexPresetId
  }, [regexPresetId])

  useEffect(() => {
    if (!status) {
      return
    }

    const syncTimer = window.setTimeout(() => {
      setRegex((current) => (current === status.regex ? current : status.regex))
      setRegexPresetId((current) => (current === status.regexPresetId ? current : status.regexPresetId))
      setReviewBeforeSend((current) => (current === status.reviewBeforeSend ? current : status.reviewBeforeSend))
      rebuildHistoryForConfig(status.regex, status.regexPresetId)

      try {
        if (status.regex.trim()) {
          new RegExp(status.regex)
        }
        setRegexError(null)
      } catch {
        setRegexError('Invalid regex')
      }
    }, 0)

    return () => {
      window.clearTimeout(syncTimer)
    }
  }, [status])

  useEffect(() => {
    const payload: ObserverPayload = {
      sessionId,
      regex,
      regexPresetId,
      latestScanId: latestScan?.id ?? null,
      latestExtracted: latestScan?.extracted ?? '',
      latestNormalizedText: latestScan?.normalizedText ?? '',
      latestRawText: latestScan?.text ?? '',
      updatedAt: latestScan?.receivedAt ?? null,
    }

    window.__scanBridgeObserver = payload
    localStorage.setItem(OBSERVER_KEY, JSON.stringify(payload))
  }, [latestScan, regex, regexPresetId, sessionId])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void bootstrapSession()
    }, 0)

    return () => {
      window.clearTimeout(timeoutId)
    }

    // This should run once on initial desktop load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!sessionId) return

    const captureUrl = `${window.location.origin}/capture/${sessionId}`
    void import('qrcode').then(({ default: QRCode }) => {
      QRCode.toDataURL(captureUrl, { margin: 1, width: 240 }).then(setQrCode)
    })
  }, [sessionId])

  function handleRegexChange(value: string) {
    setRegex(value)
    const nextPresetId = detectPresetId(value)
    setRegexPresetId(nextPresetId)

    try {
      if (value.trim()) {
        new RegExp(value)
      }
      setRegexError(null)
    } catch {
      setRegexError('Invalid regex')
    }
    rebuildHistoryForConfig(value, nextPresetId)
    void syncConfig(buildSessionConfig(value, nextPresetId, reviewBeforeSend))
  }

  function handlePresetChange(nextPresetId: RegexPresetId) {
    setRegexPresetId(nextPresetId)

    const preset = REGEX_PRESETS.find((item) => item.id === nextPresetId)
    if (preset && preset.pattern) {
      setRegex(preset.pattern)
      setRegexError(null)
      rebuildHistoryForConfig(preset.pattern, nextPresetId)
      void syncConfig(buildSessionConfig(preset.pattern, nextPresetId, reviewBeforeSend))
      return
    }

    rebuildHistoryForConfig(regex, nextPresetId)
    void syncConfig(buildSessionConfig(regex, nextPresetId, reviewBeforeSend))
  }

  function handleReviewModeToggle() {
    const nextValue = !reviewBeforeSend
    setReviewBeforeSend(nextValue)
    void syncConfig(buildSessionConfig(regex, regexPresetId, nextValue))
  }

  const captureUrl = sessionId ? `${window.location.origin}/capture/${sessionId}` : ''
  const connectionState = connectionStateFromPeer(Boolean(status?.mobileConnected), hasPeerConnectedOnce)
  const visibleSocketError = getVisibleSocketError(socketError)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex justify-end">
        <AppearanceToggle theme={theme} onToggle={onToggleTheme} />
      </div>

      <section className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="gap-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle>Connection</CardTitle>
                <div className="flex items-center gap-2">
                  <span className={connectionState === 'connected' ? 'h-2.5 w-2.5 rounded-full bg-emerald-500' : 'h-2.5 w-2.5 rounded-full bg-red-500'} />
                  <span className="text-sm font-medium text-zinc-950 dark:text-zinc-50">{connectionState}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input id="session-id" value={sessionId ?? ''} readOnly />
                <Button variant="outline" onClick={() => void ensureSession(true)} disabled={loadingSession}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Reset
                </Button>
              </div>

              <div className="grid gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
                {qrCode ? (
                  <img
                    src={qrCode}
                    alt="Pairing QR code"
                    className="mx-auto w-56 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-700"
                  />
                ) : (
                  <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-white text-sm text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-500">
                    Generating QR code
                  </div>
                )}
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Scan this QR code on your device with a camera to connect.
                </p>
                <Input value={captureUrl} readOnly />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Rescan the QR code any time to reconnect.</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="regex-preset">Detection mode</Label>
                <select
                  id="regex-preset"
                  value={regexPresetId}
                  onChange={(event) => handlePresetChange(event.target.value as RegexPresetId)}
                  className="flex h-10 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950/20 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:ring-zinc-50/20"
                >
                  {REGEX_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <Input
                  id="regex"
                  value={regex}
                  onChange={(event) => handleRegexChange(event.target.value)}
                  placeholder={regexPresetId === 'custom' ? '\\b[A-Z0-9]{8,12}\\b' : 'Preset controls matching'}
                />
                {regexError ? <p className="text-sm text-red-600">{regexError}</p> : null}
                <Button variant="outline" onClick={handleReviewModeToggle}>
                  {reviewBeforeSend ? 'Review on phone: on' : 'Review on phone: off'}
                </Button>
              </div>

              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                Last activity: {formatTime(status?.lastActivityAt ?? null)}
              </div>
              {socketState !== 'connected' && visibleSocketError ? <p className="text-xs text-red-600">{visibleSocketError}</p> : null}
              {pendingScan ? <p className="text-xs text-zinc-500 dark:text-zinc-400">Phone review pending</p> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Current result</CardTitle>
              <CardDescription>Latest detected value and the raw OCR text behind it.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p id="latest-extracted-value" className="font-mono text-sm text-zinc-950 dark:text-zinc-50">
                {latestScan?.extracted || 'No detected value yet'}
              </p>
              <p id="latest-raw-value" className="whitespace-pre-wrap font-mono text-sm text-zinc-600 dark:text-zinc-400">
                {latestScan?.text || 'No OCR text yet'}
              </p>
              <div
                id="scan-bridge-observer"
                data-scan-id={latestScan?.id ?? ''}
                data-session-id={sessionId ?? ''}
                data-regex={regex}
                data-regex-preset={regexPresetId}
                data-extracted={latestScan?.extracted ?? ''}
                data-normalized={latestScan?.normalizedText ?? ''}
              />
            </CardContent>
          </Card>
        </div>

        <Card className="min-h-[560px]">
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Scan history</CardTitle>
                <CardDescription>Newest first. Stored locally in this browser until cleared.</CardDescription>
              </div>
              <Button variant="outline" onClick={() => setHistory([])}>
                <Trash2 className="mr-2 h-4 w-4" />
                Clear scans
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3">
              {history.length === 0 ? (
                <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-300 bg-zinc-50 text-center dark:border-zinc-700 dark:bg-zinc-900">
                  <ScanLine className="mb-3 h-8 w-8 text-zinc-400" />
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">No scans yet</p>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Pair the phone and capture a label.</p>
                </div>
              ) : null}

              {history.map((scan) => (
                <article key={scan.id} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={scan.extracted ? 'success' : 'default'}>
                        {scan.extracted ? 'Detected value' : 'Raw OCR'}
                      </Badge>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">{new Date(scan.receivedAt).toLocaleString()}</span>
                    </div>
                    <p className="font-mono text-lg text-zinc-950 dark:text-zinc-50">
                      {scan.extracted ?? (scan.normalizedText || 'No text detected')}
                    </p>
                    <p className="whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">{scan.text || 'No OCR output returned.'}</p>
                  </div>
                </article>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  )
}

function MobilePage({
  theme,
  onToggleTheme,
}: {
  theme: ThemeMode
  onToggleTheme: () => void
}) {
  const { sessionId = '' } = useParams()
  const { status, lastScan, pendingScan, socketError, socketState, hasConnectedOnce, hasPeerConnectedOnce } = useSessionSocket(sessionId, 'mobile')
  const [cameraReady, setCameraReady] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadQuality, setUploadQuality] = useState<UploadQuality>('fast')
  const [regex, setRegex] = useState('\\b[A-Z0-9]{8,12}\\b')
  const [regexPresetId, setRegexPresetId] = useState<RegexPresetId>('macSerial')
  const [reviewBeforeSend, setReviewBeforeSend] = useState(false)
  const [regexError, setRegexError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [pendingDraftText, setPendingDraftText] = useState('')
  const [pendingDraftRegexResult, setPendingDraftRegexResult] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    if (!status) {
      return
    }

    const syncTimer = window.setTimeout(() => {
      setRegex(status.regex)
      setRegexPresetId(status.regexPresetId)
      setReviewBeforeSend(status.reviewBeforeSend)

      try {
        if (status.regex.trim()) {
          new RegExp(status.regex)
        }
        setRegexError(null)
      } catch {
        setRegexError('Invalid regex')
      }
    }, 0)

    return () => {
      window.clearTimeout(syncTimer)
    }
  }, [status])

  useEffect(() => {
    const syncTimer = window.setTimeout(() => {
      setPendingDraftText(pendingScan?.text ?? '')
      setPendingDraftRegexResult(pendingScan ? extractPresetMatch(pendingScan, regexPresetId, regex) ?? '' : '')
    }, 0)

    return () => {
      window.clearTimeout(syncTimer)
    }
  }, [pendingScan, regex, regexPresetId])

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = stream

      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }

      setCameraReady(true)
      setError(null)
    } catch {
      setError('Camera access failed. Use photo upload instead.')
    }
  }

  async function sendBlob(blob: Blob) {
    setUploading(true)
    setError(null)

    try {
      let uploadBlob = blob
      try {
        uploadBlob = await optimizeImageForUpload(blob, uploadQuality)
      } catch {
        uploadBlob = blob
      }

      const formData = new FormData()
      formData.append('image', uploadBlob, `capture-${Date.now()}.jpg`)

      const abortController = new AbortController()
      const timeoutId = window.setTimeout(() => {
        abortController.abort()
      }, 30000)

      const response = await fetch(`/api/session/${sessionId}/scan`, {
        method: 'POST',
        body: formData,
        signal: abortController.signal,
      }).finally(() => {
        window.clearTimeout(timeoutId)
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? 'Upload failed')
      }
    } catch (uploadError) {
      if (uploadError instanceof Error && uploadError.name === 'AbortError') {
        setError('Scan timed out. Try again.')
      } else {
        setError(uploadError instanceof Error ? uploadError.message : 'Upload failed')
      }
    } finally {
      setUploading(false)
    }
  }

  async function captureFrame() {
    const video = videoRef.current
    const canvas = canvasRef.current

    if (!video || !canvas) {
      return
    }

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')

    if (!context) {
      setError('Canvas capture unavailable')
      return
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    })

    if (!blob) {
      setError('Capture failed')
      return
    }

    await sendBlob(blob)
  }

  async function handleFileUpload(file: File | undefined) {
    if (!file) {
      return
    }

    await sendBlob(file)
  }

  async function syncConfig(nextConfig: SessionConfig) {
    if (!sessionId) return
    await pushSessionConfig(sessionId, nextConfig)
  }

  function handleRegexChange(value: string) {
    setRegex(value)
    const nextPresetId = detectPresetId(value)
    setRegexPresetId(nextPresetId)

    try {
      if (value.trim()) {
        new RegExp(value)
      }
      setRegexError(null)
    } catch {
      setRegexError('Invalid regex')
    }

    void syncConfig(buildSessionConfig(value, nextPresetId, reviewBeforeSend))
  }

  function handlePresetChange(nextPresetId: RegexPresetId) {
    setRegexPresetId(nextPresetId)
    const preset = REGEX_PRESETS.find((item) => item.id === nextPresetId)
    if (preset && preset.pattern) {
      setRegex(preset.pattern)
      setRegexError(null)
      void syncConfig(buildSessionConfig(preset.pattern, nextPresetId, reviewBeforeSend))
      return
    }

    void syncConfig(buildSessionConfig(regex, nextPresetId, reviewBeforeSend))
  }

  function handleReviewModeToggle() {
    const nextValue = !reviewBeforeSend
    setReviewBeforeSend(nextValue)
    void syncConfig(buildSessionConfig(regex, regexPresetId, nextValue))
  }

  async function confirmPendingScan() {
    setConfirming(true)
    setError(null)

    try {
      const response = await fetch(`/api/session/${sessionId}/confirm-pending`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: pendingDraftText,
          regexResult: pendingDraftRegexResult,
        }),
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? 'Confirm failed')
      }
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : 'Confirm failed')
    } finally {
      setConfirming(false)
    }
  }

  async function discardPendingScan() {
    setConfirming(true)
    setError(null)

    try {
      const response = await fetch(`/api/session/${sessionId}/pending-scan`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string }
        throw new Error(payload.error ?? 'Discard failed')
      }
    } catch (discardError) {
      setError(discardError instanceof Error ? discardError.message : 'Discard failed')
    } finally {
      setConfirming(false)
    }
  }

  const pendingExtracted = pendingScan ? extractPresetMatch(pendingScan, regexPresetId, regex) : null
  const previewRegexResult = pendingDraftRegexResult || pendingExtracted || ''
  const previewNormalizedText = normalizeClientText(`${previewRegexResult} ${pendingDraftText}`)

  const scannerState = connectionStateFromSocket(socketState, hasConnectedOnce)
  const receiverState = connectionStateFromPeer(Boolean(status?.desktopConnected), hasPeerConnectedOnce)
  const connectionState =
    scannerState === 'connected' && receiverState === 'connected'
      ? 'connected'
      : scannerState !== 'not connected' || receiverState !== 'not connected'
        ? 'disconnected'
        : 'not connected'
  const visibleSocketError = getVisibleSocketError(socketError)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col gap-4 px-4 py-5">
      <div className="flex justify-end">
        <AppearanceToggle theme={theme} onToggle={onToggleTheme} />
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Connection</CardTitle>
            <div className="flex items-center gap-2">
              <span className={connectionState === 'connected' ? 'h-2.5 w-2.5 rounded-full bg-emerald-500' : 'h-2.5 w-2.5 rounded-full bg-red-500'} />
              <span className="text-sm font-medium text-zinc-950 dark:text-zinc-50">{connectionState}</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          <div>Last OCR push: {formatTime(status?.lastActivityAt ?? null)}</div>
          {connectionState !== 'connected' ? <div>Rescan the QR code on the desktop to reconnect.</div> : null}
          {visibleSocketError ? <p className="text-red-600">{visibleSocketError}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <CardDescription>These stay synced with the desktop.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="mobile-regex-preset">Detection mode</Label>
            <select
              id="mobile-regex-preset"
              value={regexPresetId}
              onChange={(event) => handlePresetChange(event.target.value as RegexPresetId)}
              className="flex h-10 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950/20 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:ring-zinc-50/20"
            >
              {REGEX_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <Input value={regex} onChange={(event) => handleRegexChange(event.target.value)} placeholder={regexPresetId === 'custom' ? '\\b[A-Z0-9]{8,12}\\b' : 'Preset controls matching'} />
            {regexError ? <p className="text-sm text-red-600">{regexError}</p> : null}
            <Button variant="outline" onClick={handleReviewModeToggle}>
              {reviewBeforeSend ? 'Review before send: on' : 'Review before send: off'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Capture</CardTitle>
          <CardDescription>{reviewBeforeSend ? 'Capture, review the OCR, then confirm.' : 'Use live camera capture or upload a photo.'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-950 dark:border-zinc-800">
            {cameraReady ? (
              <video ref={videoRef} autoPlay playsInline muted className="aspect-[3/4] w-full object-cover" />
            ) : (
              <div className="flex aspect-[3/4] flex-col items-center justify-center gap-3 text-center text-zinc-300">
                <Camera className="h-10 w-10" />
                <p className="max-w-56 text-sm">Start the rear camera for fast repeat scanning, or upload a photo below.</p>
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="quality-mode">Image quality</Label>
            <select
              id="quality-mode"
              value={uploadQuality}
              onChange={(event) => setUploadQuality(event.target.value as UploadQuality)}
              className="flex h-10 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950/20 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:ring-zinc-50/20"
            >
              <option value="fast">Reduced quality</option>
              <option value="balanced">Balanced</option>
              <option value="full">Full size</option>
            </select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Button onClick={() => void startCamera()} variant="outline">
              <Camera className="mr-2 h-4 w-4" />
              {cameraReady ? 'Restart camera' : 'Start camera'}
            </Button>
            <Button onClick={() => void captureFrame()} disabled={!cameraReady || uploading}>
              <ScanLine className="mr-2 h-4 w-4" />
              {uploading ? 'Scanning...' : reviewBeforeSend ? 'Capture for review' : 'Capture and send'}
            </Button>
          </div>

          <Label
            htmlFor="photo-upload"
            className="flex cursor-pointer items-center justify-center rounded-md border border-zinc-200 px-4 py-3 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            <Upload className="mr-2 h-4 w-4" />
            Upload photo instead
          </Label>
          <input
            id="photo-upload"
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => void handleFileUpload(event.target.files?.[0])}
          />

          {uploading ? <p className="text-sm text-zinc-500 dark:text-zinc-400">Running OCR on the Mac...</p> : null}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </CardContent>
      </Card>

      {reviewBeforeSend && pendingScan ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/45 p-3 sm:items-center sm:justify-center sm:p-6">
          <div className="w-full max-w-xl rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
              <div>
                <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">Review scan</h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Confirm or edit this before it reaches the desktop.</p>
              </div>
            </div>
            <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="pending-regex-result">Detected value</Label>
                <Input
                  id="pending-regex-result"
                  value={pendingDraftRegexResult}
                  onChange={(event) => setPendingDraftRegexResult(event.target.value)}
                  placeholder="Edit the extracted value"
                  disabled={!pendingScan}
                />
              </div>
              {pendingScan ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="pending-ocr-text">OCR text</Label>
                    <textarea
                      id="pending-ocr-text"
                      value={pendingDraftText}
                      onChange={(event) => setPendingDraftText(event.target.value)}
                      className="min-h-36 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950/20 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 dark:focus-visible:ring-zinc-50/20"
                    />
                  </div>
                  <p className="rounded-md border border-dashed border-zinc-200 px-3 py-2 font-mono text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    Final value preview: {previewRegexResult || 'No detected value'}
                  </p>
                  <p className="rounded-md border border-dashed border-zinc-200 px-3 py-2 font-mono text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    Final normalized text: {previewNormalizedText || 'No text'}
                  </p>
                </>
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">No pending preview yet.</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
              <Button onClick={() => void confirmPendingScan()} disabled={!pendingScan || confirming}>
                {confirming ? 'Working...' : 'Confirm send'}
              </Button>
              <Button variant="outline" onClick={() => void discardPendingScan()} disabled={!pendingScan || confirming}>
                Discard
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Last result</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="font-mono text-sm text-zinc-950 dark:text-zinc-50">{lastScan?.normalizedText || 'No result yet'}</p>
            {lastScan?.text ? (
              <>
                <Separator className="my-3" />
                <p className="whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">{lastScan.text}</p>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <Link2 className="h-3.5 w-3.5" />
            Keep this page open while scanning.
          </div>
        </CardContent>
      </Card>

      <canvas ref={canvasRef} className="hidden" />
    </main>
  )
}

function MissingCaptureRoute() {
  return <Navigate to="/" replace />
}

function App() {
  const isCaptureRoute = useMemo(() => window.location.pathname.startsWith('/capture/'), [])
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const storedTheme = localStorage.getItem(THEME_KEY)
    if (storedTheme === 'light' || storedTheme === 'dark') {
      return storedTheme
    }

    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  function toggleTheme() {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }

  return (
    <div className={isCaptureRoute ? 'bg-zinc-100 text-zinc-950 dark:bg-zinc-900 dark:text-zinc-50' : 'bg-white text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50'}>
      <Routes>
        <Route path="/" element={<DesktopPage theme={theme} onToggleTheme={toggleTheme} />} />
        <Route path="/capture/:sessionId" element={<MobilePage theme={theme} onToggleTheme={toggleTheme} />} />
        <Route path="*" element={<MissingCaptureRoute />} />
      </Routes>
    </div>
  )
}

export { App }
