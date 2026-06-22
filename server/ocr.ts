import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import sharp from 'sharp'

import type { OcrProfile } from '../src/types.js'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const visionBinaryPath = join(rootDir, 'bin', 'scan-bridge-vision-ocr')
const visionSourcePath = join(rootDir, 'server', 'vision-ocr.swift')

type OcrResult = {
  text: string
  normalizedText: string
}

type VisionPayload = {
  text: string
  lines: string[]
}

type ImageVariant = {
  name: string
  maxWidth: number
  maxHeight: number
  grayscale?: boolean
  normalize?: boolean
  sharpen?: boolean
  threshold?: number
}

type ScoredResult = {
  candidate: string | null
  score: number
  variant: ImageVariant
  result: VisionPayload
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function unique<T>(values: T[]) {
  return [...new Set(values)]
}

function buildLineWindows(lines: string[], maxWindowSize = 4) {
  const cleanLines = lines.map((line) => normalizeText(line)).filter(Boolean)
  const windows: string[] = []

  for (let start = 0; start < cleanLines.length; start += 1) {
    for (let size = 1; size <= maxWindowSize && start + size <= cleanLines.length; size += 1) {
      const slice = cleanLines.slice(start, start + size)
      windows.push(slice.join(' '))
      windows.push(slice.join(''))
      windows.push(slice.join(' | '))
    }
  }

  return unique(windows)
}

function stripLabelPrefixes(value: string) {
  return value
    .replace(/\b(?:serial(?:\s*(?:number|no))?|model|part|imei|emc|sku)\b[:#]?\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeDigits(value: string) {
  return value.replace(/[OQD]/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/Z/g, '2').replace(/B/g, '8')
}

function normalizeSerialCandidate(value: string) {
  return value.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/Z/g, '2')
}

function stripCompactedLabelPrefixes(value: string) {
  return value.replace(/^(?:SERIALNUMBER|SERIALNO|SERIALNUM|SERIAL|MODEL|PART|IMEI|EMC|SKU)+/i, '')
}

function tokenizeAlphaNumeric(value: string) {
  return value
    .toUpperCase()
    .split(/[^A-Z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
}

function buildTokenCandidates(value: string, maxJoin = 3) {
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

function extractLabelWindow(text: string, labelPattern: RegExp) {
  const match = text.match(labelPattern)
  return match?.[1]?.trim() ?? null
}

function normalizeAppleModelCandidate(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!compact.startsWith('A') || compact.length < 5) {
    return null
  }

  const candidate = `A${normalizeDigits(compact.slice(1))}`
  return /^A\d{4}$/.test(candidate) ? candidate : null
}

function extractAppleModelCandidate(text: string) {
  const stripped = stripLabelPrefixes(text)
  const labelWindow = extractLabelWindow(stripped, /\bmodel\b[:#\s-]*([A-Z0-9\s-]{1,20})/i)
  const searchValues = unique([
    stripped,
    labelWindow ?? '',
    ...buildTokenCandidates(stripped),
    ...(labelWindow ? buildTokenCandidates(labelWindow) : []),
  ]).filter(Boolean)
  const matches = searchValues.flatMap((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').match(/A[A-Z0-9]{4}/g) ?? [])

  for (const match of matches) {
    const candidate = normalizeAppleModelCandidate(match)
    if (candidate) {
      return candidate
    }
  }

  return null
}

function scoreMacSerialCandidate(value: string) {
  let score = value.length * 10
  if (/[A-Z]/.test(value) && /\d/.test(value)) {
    score += 30
  } else {
    score -= 40
  }

  score += (value.match(/\d/g) ?? []).length * 2
  score += (value.match(/[A-Z]/g) ?? []).length

  if ((value.match(/\d/g) ?? []).length < 2) {
    score -= 20
  }

  if (value.length >= 10) {
    score += 10
  }

  if (value.length >= 11) {
    score += 10
  }

  return score
}

function extractMacSerialCandidate(text: string) {
  const stripped = stripLabelPrefixes(text).toUpperCase()
  const labelWindow = extractLabelWindow(stripped, /\b(?:serial(?:\s*(?:number|no))?|s\/n|sn)\b[:#\s-]*([A-Z0-9\s-]{4,32})/i)
  const searchValues = unique([
    stripped,
    labelWindow ?? '',
    ...buildTokenCandidates(stripped),
    ...(labelWindow ? buildTokenCandidates(labelWindow) : []),
  ]).filter(Boolean)

  const candidates = unique(
    searchValues.flatMap((value) => {
      const labelBoost = labelWindow && value.includes(labelWindow) ? 18 : 0
      return (value.match(/\b[A-Z0-9]{8,12}\b/g) ?? []).flatMap((candidate) => {
        const correctedCandidate = normalizeSerialCandidate(stripCompactedLabelPrefixes(candidate))
        const rawDigitCount = (candidate.match(/\d/g) ?? []).length
        const canCorrect = rawDigitCount >= 2 || labelBoost > 0

        return [
          {
            candidate,
            corrected: false,
            labelBoost,
          },
          ...(canCorrect && correctedCandidate.length >= 8 && correctedCandidate.length <= 12 && correctedCandidate !== candidate
            ? [
                {
                  candidate: correctedCandidate,
                  corrected: true,
                  labelBoost,
                },
              ]
            : []),
        ]
      })
    }),
  )

  const ranked = candidates
    .filter(({ candidate, labelBoost }) => {
      const digitCount = (candidate.match(/\d/g) ?? []).length
      const letterCount = (candidate.match(/[A-Z]/g) ?? []).length
      const isStrongLabelCandidate = labelBoost >= 18 && candidate.length >= 8 && letterCount >= 6
      return ((digitCount >= 2) || isStrongLabelCandidate) && letterCount >= 2
    })
    .map(({ candidate, corrected, labelBoost }) => ({
      candidate,
      score: scoreMacSerialCandidate(candidate) + (corrected ? 6 : 0) + labelBoost,
    }))
    .sort((left, right) => right.score - left.score)

  return ranked[0]?.candidate ?? null
}

function extractProfileCandidate(profile: OcrProfile, values: string[]) {
  if (profile === 'generic') {
    return null
  }

  for (const value of values) {
    const candidate =
      profile === 'appleModel' ? extractAppleModelCandidate(value) : extractMacSerialCandidate(value)

    if (candidate) {
      return candidate
    }
  }

  return null
}

function getImageVariants(profile: OcrProfile): ImageVariant[] {
  if (profile === 'generic') {
    return [
      { name: 'enhanced', maxWidth: 2200, maxHeight: 2200, grayscale: true, normalize: true, sharpen: true },
      { name: 'thresholded', maxWidth: 2200, maxHeight: 2200, grayscale: true, normalize: true, sharpen: true, threshold: 172 },
    ]
  }

  return [
    { name: 'enhanced', maxWidth: 2600, maxHeight: 2000, grayscale: true, normalize: true, sharpen: true },
    {
      name: 'thresholded',
      maxWidth: 2600,
      maxHeight: 2000,
      grayscale: true,
      normalize: true,
      sharpen: true,
      threshold: profile === 'appleModel' ? 176 : 170,
    },
    { name: 'color', maxWidth: 2600, maxHeight: 2000 },
  ]
}

async function renderVariant(inputBuffer: Buffer, variant: ImageVariant, outputPath: string) {
  let image = sharp(inputBuffer, { limitInputPixels: false, sequentialRead: true }).rotate().resize({
    width: variant.maxWidth,
    height: variant.maxHeight,
    fit: 'inside',
    withoutEnlargement: true,
  })

  if (variant.grayscale) {
    image = image.grayscale()
  }

  if (variant.normalize) {
    image = image.normalize()
  }

  if (variant.sharpen) {
    image = image.sharpen({ sigma: 1.2, m1: 1.2, m2: 2.2, x1: 2, y2: 10, y3: 20 })
  }

  if (typeof variant.threshold === 'number') {
    image = image.threshold(variant.threshold)
  }

  await image.png({ compressionLevel: 1, palette: false }).toFile(outputPath)
}

async function executeVisionOcr(inputPath: string) {
  const hasCompiledBinary = await fs
    .access(visionBinaryPath)
    .then(() => true)
    .catch(() => false)

  const command = hasCompiledBinary ? visionBinaryPath : 'xcrun'
  const args = hasCompiledBinary ? ['--input', inputPath] : ['swift', visionSourcePath, '--input', inputPath]

  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 10 * 1024 * 1024,
  })

  const parsed = JSON.parse(stdout) as VisionPayload
  return {
    text: parsed.text.trim(),
    lines: parsed.lines.map((line) => line.trim()).filter(Boolean),
  }
}

async function executeTesseractFallback(inputPath: string) {
  const { stdout } = await execFileAsync('tesseract', [inputPath, 'stdout', '--psm', '6', '-l', 'eng+snum'], {
    maxBuffer: 10 * 1024 * 1024,
  })

  return {
    text: stdout.trim(),
    lines: stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean),
  }
}

function scoreVisionResult(profile: OcrProfile, variant: ImageVariant, result: VisionPayload): ScoredResult {
  const lineWindows = buildLineWindows(result.lines)
  const searchSpace = unique([
    ...result.lines,
    ...lineWindows,
    result.text,
    normalizeText(result.text),
    result.lines.join(' '),
    result.lines.join(''),
  ]).filter(Boolean)

  const candidate = extractProfileCandidate(profile, searchSpace)

  let score = normalizeText(result.text).length
  if (variant.name === 'enhanced') {
    score += 4
  }

  if (candidate) {
    if (profile === 'appleModel') {
      score += 100
    } else {
      score += scoreMacSerialCandidate(candidate)
    }
  }

  return { candidate, score, variant, result }
}

function buildNormalizedText(profile: OcrProfile, result: VisionPayload, candidate: string | null) {
  const rawNormalized = normalizeText(result.text)
  if (!candidate) {
    return rawNormalized
  }

  if (profile === 'appleModel') {
    return normalizeText(`${candidate} ${rawNormalized}`)
  }

  return normalizeText(`${candidate} ${rawNormalized}`)
}

export async function runOcr(buffer: Buffer, profile: OcrProfile): Promise<OcrResult> {
  const tempDir = await fs.mkdtemp(join(rootDir, '.scan-bridge-ocr-'))
  const variants = getImageVariants(profile)

  try {
    const scoredResults: ScoredResult[] = []

    for (const variant of variants) {
      const variantPath = join(tempDir, `${variant.name}.png`)
      await renderVariant(buffer, variant, variantPath)

      const result = await executeVisionOcr(variantPath)
      const scored = scoreVisionResult(profile, variant, result)
      scoredResults.push(scored)

      if (
        scored.candidate &&
        ((profile === 'appleModel' && /^A\d{4}$/.test(scored.candidate)) ||
          (profile === 'macSerial' && /^[A-Z0-9]{10,12}$/.test(scored.candidate)))
      ) {
        return {
          text: scored.result.text,
          normalizedText: buildNormalizedText(profile, scored.result, scored.candidate),
        }
      }
    }

    const bestResult = scoredResults.sort((left, right) => right.score - left.score)[0]
    if (bestResult) {
      return {
        text: bestResult.result.text,
        normalizedText: buildNormalizedText(profile, bestResult.result, bestResult.candidate),
      }
    }

    const fallbackPath = join(tempDir, 'fallback.png')
    await renderVariant(buffer, variants[0] ?? { name: 'fallback', maxWidth: 2200, maxHeight: 2200 }, fallbackPath)
    const fallback = await executeTesseractFallback(fallbackPath)
    return {
      text: fallback.text,
      normalizedText: normalizeText(fallback.text),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new Error('OCR dependencies are missing. Install Xcode command line tools or Tesseract on this Mac.', {
        cause: error,
      })
    }

    throw error
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
