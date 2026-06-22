export type OcrProfile = 'generic' | 'macSerial' | 'appleModel'

export type SessionStatus = {
  sessionId: string
  desktopConnected: boolean
  mobileConnected: boolean
  desktopCount: number
  mobileCount: number
  lastActivityAt: string | null
  ocrProfile: OcrProfile
}

export type ScanPayload = {
  id: string
  sessionId: string
  receivedAt: string
  text: string
  normalizedText: string
}
