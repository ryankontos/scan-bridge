import Foundation
import ImageIO
import Vision

struct OcrPayload: Codable {
  let text: String
  let lines: [String]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

func argumentValue(named name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name) else {
    return nil
  }

  let valueIndex = index + 1
  guard valueIndex < CommandLine.arguments.count else {
    return nil
  }

  return CommandLine.arguments[valueIndex]
}

func loadImage(at url: URL) -> CGImage? {
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
    return nil
  }

  return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func sortObservations(_ observations: [VNRecognizedTextObservation]) -> [VNRecognizedTextObservation] {
  observations.sorted { lhs, rhs in
    let lhsMidY = lhs.boundingBox.midY
    let rhsMidY = rhs.boundingBox.midY

    if abs(lhsMidY - rhsMidY) > 0.03 {
      return lhsMidY > rhsMidY
    }

    return lhs.boundingBox.minX < rhs.boundingBox.minX
  }
}

guard let inputPath = argumentValue(named: "--input") else {
  fail("Missing required argument: --input /path/to/image")
}

let inputUrl = URL(fileURLWithPath: inputPath)
guard let image = loadImage(at: inputUrl) else {
  fail("Unable to load image at \(inputPath)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]
request.minimumTextHeight = 0.01

if #available(macOS 13.0, *) {
  request.automaticallyDetectsLanguage = false
}

do {
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  try handler.perform([request])

  let observations = sortObservations(request.results ?? [])
  let lines = observations.compactMap { observation -> String? in
    guard let candidate = observation.topCandidates(1).first else {
      return nil
    }

    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  let payload = OcrPayload(
    text: lines.joined(separator: "\n"),
    lines: lines
  )

  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  let data = try encoder.encode(payload)
  FileHandle.standardOutput.write(data)
} catch {
  fail("Vision OCR failed: \(error.localizedDescription)")
}
