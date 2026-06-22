export type OcrProfile = 'generic' | 'macSerial' | 'appleModel'
export type RegexPresetId = 'macSerial' | 'appleModel' | 'custom'

export type SessionConfig = {
  regex: string
  regexPresetId: RegexPresetId
  reviewBeforeSend: boolean
}

export type SessionStatus = SessionConfig & {
  sessionId: string
  desktopConnected: boolean
  mobileConnected: boolean
  desktopCount: number
  mobileCount: number
  lastActivityAt: string | null
  ocrProfile: OcrProfile
  latestScanId: string | null
  latestPendingScanId: string | null
}

export type ScanPayload = {
  id: string
  sessionId: string
  receivedAt: string
  text: string
  normalizedText: string
}
