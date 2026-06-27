/**
 * VoiceInput — Push-to-talk or click-to-toggle voice dictation using Whisper STT.
 *
 * Two modes:
 *   1. Click and HOLD the mic (or hold Spacebar) → release to stop → auto-send
 *   2. Click once to start → click again to stop → review → send
 *
 * Architecture:
 *   Browser MediaRecorder → base64 audio → WebSocket → Node.js
 *   → whisper.cpp → transcribed text → review bar → inject into terminal
 */

import { useState, useEffect, useRef, useCallback } from 'react'

interface VoiceInputProps {
  /** Called with transcribed text when user sends */
  onTranscript: (text: string) => void
  /** Currently active session name (for display) */
  sessionName: string | null
  /** Send a message over the WebSocket to the backend */
  sendToServer: (msg: any) => void
  /** Register a callback for transcription results */
  onTranscriptionResult: (handler: (text: string, requestId: string, error?: string) => void) => () => void
}

export function VoiceInput({ onTranscript, sessionName, sendToServer, onTranscriptionResult }: VoiceInputProps) {
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastTranscript, setLastTranscript] = useState('')
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const mimeTypeRef = useRef<string>('audio/webm;codecs=opus')
  const isRecordingRef = useRef(false) // mirror for window-level listeners

  // ── Enumerate audio input devices ──────────────────────────────
  // Must request mic permission first so labels are populated.

  useEffect(() => {
    const refresh = async () => {
      try {
        // Brief permission probe so enumerateDevices returns labels
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
        probe.getTracks().forEach(t => t.stop())
      } catch { /* permission denied — labels will be empty */ }

      const all = await navigator.mediaDevices.enumerateDevices()
      const inputs = all.filter(d => d.kind === 'audioinput')
      setAudioDevices(inputs)
      // Keep current selection if it still exists, otherwise pick first
      setSelectedDeviceId(id => inputs.find(d => d.deviceId === id) ? id : (inputs[0]?.deviceId ?? ''))
    }

    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [])

  // ── Register for transcription results ─────────────────────────

  useEffect(() => {
    const unsubscribe = onTranscriptionResult((text: string, requestId: string, error?: string) => {
      if (requestId !== requestIdRef.current) return
      setIsTranscribing(false)
      requestIdRef.current = null

      if (text.trim()) {
        setLastTranscript(text.trim())
      } else {
        setError(error || 'No speech detected')
        setTimeout(() => setError(null), 3000)
      }
    })
    return unsubscribe
  }, [onTranscriptionResult])

  // ── Start recording ────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current || isTranscribing) return
    setError(null)
    setLastTranscript('')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream

      // Pick the best available codec
      const mimes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      mimeTypeRef.current = mimes.find(m => MediaRecorder.isTypeSupported(m)) || ''

      const recorder = new MediaRecorder(stream, {
        mimeType: mimeTypeRef.current || undefined,
      })
      audioChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data)
          console.log(`[voice] Chunk received: ${e.data.size} bytes`)
        }
      }

      // Pass timeslice=250ms so dataavailable fires periodically.
      // Without this, some browsers buffer everything internally and
      // may produce empty or truncated audio on stop().
      recorder.start(250)
      mediaRecorderRef.current = recorder
      isRecordingRef.current = true
      setIsRecording(true)
      console.log('[voice] Recording started, mimeType:', mimeTypeRef.current)
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setError('Microphone permission denied')
      } else {
        setError(`Microphone error: ${err.message}`)
      }
    }
  }, [isTranscribing])

  // ── Stop recording → send to Whisper ───────────────────────────

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      isRecordingRef.current = false
      setIsRecording(false)
      return
    }

    recorder.onstop = async () => {
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      isRecordingRef.current = false
      setIsRecording(false)

      const audioBlob = new Blob(audioChunksRef.current, { type: mimeTypeRef.current })
      console.log(`[voice] Recording stopped. Blob: ${audioBlob.size} bytes, ${audioChunksRef.current.length} chunks`)

      if (audioBlob.size < 500) {
        console.warn('[voice] Audio blob too small, skipping')
        return
      }

      const reader = new FileReader()
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1]
        console.log(`[voice] Sending ${base64.length} chars of base64 audio to Whisper`)
        const requestId = `stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        requestIdRef.current = requestId
        setIsTranscribing(true)

        sendToServer({
          type: 'transcribe',
          requestId,
          audio: base64,
          mimeType: mimeTypeRef.current,
        })
      }
      reader.readAsDataURL(audioBlob)
    }

    recorder.stop()
  }, [sendToServer])

  // ── Window-level mouseup safety net ────────────────────────────
  // If the user moves the mouse off the button while holding, the
  // button's onMouseUp never fires. This catches that case.

  useEffect(() => {
    const handleWindowMouseUp = () => {
      if (isRecordingRef.current) {
        stopRecording()
      }
    }
    window.addEventListener('mouseup', handleWindowMouseUp)
    return () => window.removeEventListener('mouseup', handleWindowMouseUp)
  }, [stopRecording])

  // ── Push-to-talk: hold Spacebar ────────────────────────────────

  useEffect(() => {
    let spaceDown = false

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !spaceDown && !e.repeat && !isTranscribing) {
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

        spaceDown = true
        e.preventDefault()
        startRecording()
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && spaceDown) {
        spaceDown = false
        e.preventDefault()
        stopRecording()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [startRecording, stopRecording, isTranscribing])

  // ── Cleanup on unmount ─────────────────────────────────────────

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ── Send transcript to active session ──────────────────────────

  const handleSend = () => {
    if (lastTranscript.trim()) {
      onTranscript(lastTranscript.trim() + '\r')
      setLastTranscript('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className={`voice-input ${isRecording ? 'recording' : ''} ${isTranscribing ? 'transcribing' : ''}`}>
      <button
        className="mic-button"
        onMouseDown={(e) => {
          e.preventDefault()
          if (isRecording) {
            // Toggle mode: click while recording = stop
            stopRecording()
          } else {
            startRecording()
          }
        }}
        onTouchStart={(e) => {
          e.preventDefault()
          if (!isRecording) startRecording()
          else stopRecording()
        }}
        disabled={isTranscribing}
        title={isTranscribing ? 'Transcribing...' : isRecording ? 'Click to stop recording' : 'Click to dictate (or hold Space)'}
      >
        <span className="mic-icon">
          {isRecording ? '⏹️' : isTranscribing ? '⏳' : '🎙️'}
        </span>
      </button>

      {audioDevices.length > 1 && !isRecording && !isTranscribing && (
        <select
          className="mic-device-select"
          value={selectedDeviceId}
          onChange={e => setSelectedDeviceId(e.target.value)}
          title="Select microphone"
        >
          {audioDevices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
      )}

      <div className="voice-feedback">
        {/* Recording state */}
        {isRecording && (
          <div className="voice-recording">
            <div className="voice-waveform">
              <span></span><span></span><span></span><span></span><span></span>
            </div>
            <span className="voice-status">Listening... click ⏹️ to stop</span>
          </div>
        )}

        {/* Transcribing state */}
        {isTranscribing && (
          <span className="voice-status transcribing">Transcribing via Whisper...</span>
        )}

        {/* Idle with no transcript */}
        {!isRecording && !isTranscribing && !lastTranscript && !error && (
          <span className="voice-hint">
            Hold <kbd>Space</kbd> or click 🎙️ to dictate
            {sessionName ? ` → ${sessionName}` : ''}
          </span>
        )}

        {/* Transcription result — review and send */}
        {lastTranscript && !isRecording && !isTranscribing && (
          <div className="voice-review">
            <input
              type="text"
              className="voice-transcript-input"
              value={lastTranscript}
              onChange={(e) => setLastTranscript(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              placeholder="Review transcription..."
            />
            <button
              className="voice-send-btn"
              onClick={handleSend}
              title="Send to session (Enter)"
            >
              Send ↵
            </button>
            <button
              className="voice-discard-btn"
              onClick={() => setLastTranscript('')}
              title="Discard"
            >
              ✕
            </button>
          </div>
        )}

        {/* Error */}
        {error && !isRecording && !isTranscribing && (
          <div className="voice-error">{error}</div>
        )}
      </div>
    </div>
  )
}
