import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import sharp from 'sharp'

import type { OcrProfile } from '../src/types.js'

const execFileAsync = promisify(execFile)

type OcrRunConfig = {
  tesseractArgs: string[]
  threshold: number
  maxWidth: number
  maxHeight: number
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function getOcrRunConfig(profile: OcrProfile): OcrRunConfig {
  switch (profile) {
    case 'macSerial':
      return {
        tesseractArgs: [
          'stdout',
          '--psm',
          '7',
          '-l',
          'eng+snum',
          '-c',
          'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        ],
        threshold: 165,
        maxWidth: 1600,
        maxHeight: 900,
      }
    case 'appleModel':
      return {
        tesseractArgs: [
          'stdout',
          '--psm',
          '7',
          '-l',
          'eng+snum',
          '-c',
          'tessedit_char_whitelist=A0123456789',
        ],
        threshold: 168,
        maxWidth: 1400,
        maxHeight: 800,
      }
    default:
      return {
        tesseractArgs: ['stdout', '--psm', '6', '-l', 'eng+snum'],
        threshold: 170,
        maxWidth: 1800,
        maxHeight: 1200,
      }
  }
}

async function executeTesseract(inputPath: string, args: string[]) {
  const { stdout } = await execFileAsync('tesseract', [inputPath, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  })

  return {
    text: stdout.trim(),
    normalizedText: normalizeText(stdout),
  }
}

export async function runOcr(buffer: Buffer, profile: OcrProfile) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-bridge-'))
  const inputPath = path.join(tempDir, 'capture.png')
  const fastConfig = getOcrRunConfig(profile)
  const genericConfig = getOcrRunConfig('generic')

  try {
    await sharp(buffer, { limitInputPixels: false, sequentialRead: true })
      .rotate()
      .grayscale()
      .normalize()
      .sharpen()
      .resize({
        width: fastConfig.maxWidth,
        height: fastConfig.maxHeight,
        fit: 'inside',
        withoutEnlargement: false,
      })
      .threshold(fastConfig.threshold)
      .png({ compressionLevel: 1, palette: false })
      .toFile(inputPath)

    const fastResult = await executeTesseract(inputPath, fastConfig.tesseractArgs)
    if (profile === 'generic' || fastResult.normalizedText.length >= 4) {
      return fastResult
    }

    await sharp(buffer, { limitInputPixels: false, sequentialRead: true })
      .rotate()
      .grayscale()
      .normalize()
      .sharpen()
      .resize({
        width: genericConfig.maxWidth,
        height: genericConfig.maxHeight,
        fit: 'inside',
        withoutEnlargement: false,
      })
      .threshold(genericConfig.threshold)
      .png()
      .toFile(inputPath)

    return await executeTesseract(inputPath, genericConfig.tesseractArgs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Tesseract is not installed. Run `brew install tesseract` on this Mac.', {
        cause: error,
      })
    }

    throw error
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
