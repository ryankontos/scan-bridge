import type { RegexPresetId, ScanPayload } from '../types'

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function unique<T>(values: T[]) {
  return [...new Set(values)]
}

function stripLabelPrefixes(value: string) {
  return value
    .replace(/\b(?:serial(?:\s*(?:number|no))?|model|part|imei|emc|sku)\b[:#]?\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractLabelWindow(text: string, labelPattern: RegExp) {
  const match = text.match(labelPattern)
  return match?.[1]?.trim() ?? null
}

function normalizeDigits(value: string) {
  return value.replace(/[OQD]/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/Z/g, '2').replace(/B/g, '8')
}

function normalizeSerialCandidate(value: string) {
  return value.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/Z/g, '2')
}

function tokenizeAlphaNumeric(value: string) {
  return value
    .toUpperCase()
    .split(/[^A-Z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
}

function buildTokenWindows(value: string, maxJoin = 3) {
  const tokens = tokenizeAlphaNumeric(value)
  const candidates: string[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    for (let size = 1; size <= maxJoin && index + size <= tokens.length; size += 1) {
      const candidate = tokens.slice(index, index + size).join('')
      if (candidate.length >= 4 && candidate.length <= 14) {
        candidates.push(candidate)
      }
    }
  }

  return unique(candidates)
}

function scoreSerialCandidate(value: string, labelBoost: number, corrected: boolean) {
  const digitCount = (value.match(/\d/g) ?? []).length
  const letterCount = (value.match(/[A-Z]/g) ?? []).length

  const isStrongLabelCandidate = labelBoost >= 40 && value.length >= 8 && letterCount >= 6
  if ((!isStrongLabelCandidate && digitCount < 2) || letterCount < 2) {
    return -1_000
  }

  let score = value.length * 10
  score += digitCount * 2
  score += letterCount
  score += labelBoost

  if (digitCount >= 2 && letterCount >= 2) {
    score += 30
  } else if (isStrongLabelCandidate) {
    score += 24
  }

  if (value.length >= 10) {
    score += 10
  }

  if (value.length >= 11) {
    score += 10
  }

  if (corrected) {
    score += 6
  }

  return score
}

function extractMacSerialFromText(rawText: string, normalizedText: string) {
  const raw = rawText.toUpperCase()
  const labelWindow = extractLabelWindow(raw, /\b(?:serial(?:\s*(?:number|no))?|s\/n|sn)\b[:#\s-]*([A-Z0-9\s-]{4,32})/i)
  const rankCandidates = (values: string[], labelBoost: number) =>
    values
      .flatMap((value) => {
        return (value.match(/\b[A-Z0-9]{8,12}\b/g) ?? []).flatMap((candidate) => {
          const correctedCandidate = normalizeSerialCandidate(candidate)
          const rawDigitCount = (candidate.match(/\d/g) ?? []).length
          const canCorrect = rawDigitCount >= 2 || labelBoost > 0

          return [
            { candidate, corrected: false, labelBoost },
            ...(canCorrect && correctedCandidate !== candidate ? [{ candidate: correctedCandidate, corrected: true, labelBoost }] : []),
          ]
        })
      })
      .map(({ candidate, corrected, labelBoost: currentBoost }) => ({
        candidate,
        score: scoreSerialCandidate(candidate, currentBoost, corrected),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)

  if (labelWindow) {
    const labelRanked = rankCandidates([labelWindow, ...buildTokenWindows(labelWindow)], 60)
    if (labelRanked[0]?.candidate) {
      return labelRanked[0].candidate
    }
  }

  const searchValues = unique([
    raw,
    labelWindow ?? '',
    normalizedText.toUpperCase(),
    ...buildTokenWindows(raw),
    ...buildTokenWindows(normalizedText),
    ...(labelWindow ? buildTokenWindows(labelWindow) : []),
  ]).filter(Boolean)

  const ranked = rankCandidates(
    searchValues,
    labelWindow ? 18 : 0,
  )

  return ranked[0]?.candidate ?? null
}

function extractAppleModelFromText(rawText: string, normalizedText: string) {
  const raw = stripLabelPrefixes(rawText)
  const labelWindow = extractLabelWindow(raw, /\bmodel\b[:#\s-]*([A-Z0-9\s-]{1,20})/i)
  const searchValues = unique([
    raw,
    normalizedText,
    labelWindow ?? '',
    ...buildTokenWindows(raw),
    ...buildTokenWindows(normalizedText),
    ...(labelWindow ? buildTokenWindows(labelWindow) : []),
  ]).filter(Boolean)

  for (const value of searchValues) {
    const matches = value.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/A[A-Z0-9]{4}/g) ?? []
    for (const match of matches) {
      const normalizedCandidate = `A${normalizeDigits(match.slice(1))}`
      if (/^A\d{4}$/.test(normalizedCandidate)) {
        return normalizedCandidate
      }
    }
  }

  return null
}

function applyCustomRegex(text: string, pattern: string) {
  if (!pattern.trim()) {
    return null
  }

  try {
    const regex = new RegExp(pattern, 'g')
    const match = text.match(regex)
    return match?.[0] ?? null
  } catch {
    return null
  }
}

export function extractPresetMatch(scan: Pick<ScanPayload, 'text' | 'normalizedText'>, presetId: RegexPresetId, pattern: string) {
  const rawText = scan.text || ''
  const normalizedText = normalizeText(scan.normalizedText || rawText)

  switch (presetId) {
    case 'macSerial':
      return extractMacSerialFromText(rawText, normalizedText)
    case 'appleModel':
      return extractAppleModelFromText(rawText, normalizedText)
    default:
      return applyCustomRegex(normalizedText, pattern) ?? applyCustomRegex(rawText, pattern)
  }
}
