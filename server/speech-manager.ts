/**
 * SpeechManager — NVIDIA Parakeet TDT 0.6B v2 via sherpa-onnx.
 *
 * Replaces whisper-cpp-node with sherpa-onnx running NVIDIA's Parakeet model.
 * Parakeet is ~2× faster and ~2× more accurate than Whisper base.en,
 * with proper punctuation and casing.
 *
 * Uses the OfflineRecognizer (non-streaming) API — perfect for push-to-talk
 * where we transcribe a complete recording after the user stops.
 *
 * Audio pipeline: WebM/Opus (browser) → ffmpeg → 16kHz mono WAV samples
 * → sherpa-onnx OfflineRecognizer → text
 */

import { createRequire } from 'node:module'
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const sherpa_onnx = require('sherpa-onnx-node')

// ── Model resolution ────────────────────────────────────────────

function resolveModelDir(): string {
  const candidates = [
    process.env.PARAKEET_MODEL_DIR,
    path.join(process.cwd(), 'models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'),
    path.join(process.env.HOME || '', '.agent-multiplexer', 'models', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'),
  ].filter(Boolean) as string[]

  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, 'encoder.int8.onnx'))) return dir
  }

  throw new Error(
    'Parakeet model not found. Download:\n' +
    '  cd models && wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2\n' +
    '  tar xf sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2\n' +
    'Or set PARAKEET_MODEL_DIR env var.'
  )
}

// ── SpeechManager ───────────────────────────────────────────────

class SpeechManager {
  private recognizer: any = null
  private initPromise: Promise<any> | null = null
  private modelDir: string | null = null

  get ready(): boolean {
    return this.recognizer !== null
  }

  get model(): string | null {
    return this.modelDir
  }

  private async getRecognizer(): Promise<any> {
    if (this.recognizer) return this.recognizer
    if (this.initPromise) return this.initPromise

    this.initPromise = this.init()
    this.recognizer = await this.initPromise
    return this.recognizer
  }

  private async init(): Promise<any> {
    this.modelDir = resolveModelDir()
    console.log(`[parakeet] Loading model from: ${this.modelDir}`)

    const config = {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig: {
        transducer: {
          encoder: path.join(this.modelDir, 'encoder.int8.onnx'),
          decoder: path.join(this.modelDir, 'decoder.int8.onnx'),
          joiner: path.join(this.modelDir, 'joiner.int8.onnx'),
        },
        tokens: path.join(this.modelDir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
        modelType: 'nemo_transducer',
      },
    }

    const recognizer = new sherpa_onnx.OfflineRecognizer(config)
    console.log('[parakeet] Model loaded, ready for transcription')
    return recognizer
  }

  /**
   * Transcribe an audio buffer (WebM/Opus from MediaRecorder, or WAV) to text.
   * Pipeline: WebM → ffmpeg → 16kHz mono Float32 samples → Parakeet → text
   */
  async transcribeWebM(audioBuffer: Buffer): Promise<string> {
    const recognizer = await this.getRecognizer()

    console.log(`[parakeet] Input buffer: ${audioBuffer.length} bytes`)

    // Convert to 16kHz mono WAV
    const wavBuffer = await this.convertToWav(audioBuffer)
    console.log(`[parakeet] WAV buffer: ${wavBuffer.length} bytes`)

    if (wavBuffer.length < 1000) {
      console.warn('[parakeet] WAV output suspiciously small — audio may be empty')
      return ''
    }

    // Parse WAV into Float32 samples using sherpa-onnx's built-in reader
    const tmpFile = `/tmp/parakeet-${Date.now()}.wav`
    writeFileSync(tmpFile, wavBuffer)

    try {
      const wave = sherpa_onnx.readWave(tmpFile)
      console.log(`[parakeet] Samples: ${wave.samples.length}, sampleRate: ${wave.sampleRate}`)

      if (!wave.samples.length) {
        console.warn('[parakeet] readWave returned 0 samples — WAV may be malformed or empty')
        return ''
      }

      // Amplitude check — if max abs value is near zero, audio is silence
      let maxAmp = 0
      for (let i = 0; i < wave.samples.length; i++) {
        const abs = Math.abs(wave.samples[i])
        if (abs > maxAmp) maxAmp = abs
      }
      console.log(`[parakeet] Max amplitude: ${maxAmp.toFixed(4)} (0=silence, 1=full scale)`)

      const stream = recognizer.createStream()
      stream.acceptWaveform({
        sampleRate: wave.sampleRate,
        samples: wave.samples,
      })

      const startMs = Date.now()
      recognizer.decode(stream)
      const result = recognizer.getResult(stream)
      const elapsed = Date.now() - startMs

      const text = (result?.text || '').trim()
      console.log(`[parakeet] Decoded in ${elapsed}ms → "${text.slice(0, 100)}"`)

      return text
    } finally {
      try { unlinkSync(tmpFile) } catch { /* best effort */ }
    }
  }

  /**
   * Convert any audio format to 16kHz mono WAV using ffmpeg.
   * Falls back to writing a raw PCM WAV header manually if ffmpeg
   * produces an invalid streaming size (0xFFFFFFFF — known ffmpeg pipe bug).
   */
  private convertToWav(inputBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const errorChunks: Buffer[] = []

      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-f', 'wav',
        '-fflags', '+bitexact',  // suppress LIST/INFO metadata chunk — some WAV readers (incl. sherpa-onnx) choke on it
        'pipe:1',
        '-y',
      ])

      ffmpeg.stdin.on('error', (e) => {
        if ((e as NodeJS.ErrnoException).code !== 'EPIPE') reject(e)
      })

      ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      ffmpeg.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk))

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          const stderr = Buffer.concat(errorChunks).toString()
          console.error(`[parakeet] ffmpeg stderr: ${stderr.slice(0, 300)}`)
          reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 200)}`))
          return
        }

        const out = Buffer.concat(chunks)
        console.log(`[parakeet] ffmpeg converted ${inputBuffer.length} → ${out.length} bytes`)

        // ffmpeg writes 0xFFFFFFFF as the RIFF chunk size when streaming to
        // stdout. sherpa-onnx's readWave can't handle this. Fix the header.
        const fixed = fixWavHeader(out)
        if (fixed !== out) {
          console.log(`[parakeet] Fixed WAV header (streaming size → actual)`)
        }
        resolve(fixed)
      })

      ffmpeg.on('error', (err) => {
        if (err.message.includes('ENOENT')) {
          reject(new Error('ffmpeg not found. Install: brew install ffmpeg'))
        } else {
          reject(err)
        }
      })

      ffmpeg.stdin.write(inputBuffer)
      ffmpeg.stdin.end()
    })
  }
}

// Singleton
export const speechManager = new SpeechManager()

// ── Utilities ───────────────────────────────────────────────────

/**
 * Fix WAV headers that ffmpeg produces when streaming to stdout.
 * ffmpeg writes 0xFFFFFFFF as the RIFF chunk size because it doesn't
 * know the final size when piping. This patches the header with the
 * correct size so parsers like sherpa-onnx's readWave can read it.
 */
function fixWavHeader(buf: Buffer): Buffer {
  if (buf.length < 44) return buf

  // Check if RIFF size is 0xFFFFFFFF (the streaming sentinel)
  const riffSize = buf.readUInt32LE(4)
  if (riffSize !== 0xFFFFFFFF) return buf

  // Patch RIFF size = fileSize - 8
  buf.writeUInt32LE(buf.length - 8, 4)

  // Find the data chunk and fix its size too
  // Standard WAV: offset 0=RIFF, 8=WAVE, 12=fmt chunk, then data chunk
  let offset = 12
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    if (chunkId === 'data') {
      // Patch data size = remaining bytes
      buf.writeUInt32LE(buf.length - offset - 8, offset + 4)
      break
    }
    if (chunkSize === 0xFFFFFFFF || chunkSize === 0) break
    offset += 8 + chunkSize
    // Chunks are word-aligned
    if (chunkSize % 2 !== 0) offset += 1
  }

  return buf
}
