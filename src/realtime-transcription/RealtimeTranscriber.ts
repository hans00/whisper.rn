/* eslint-disable class-methods-use-this */
import type { VadOptions } from '../index'
import { SliceManager } from './SliceManager'
import { RingBuffer } from './RingBuffer'
import { WavFileWriter, WavFileWriterFs } from '../utils/WavFileWriter'
import type {
  RealtimeOptions,
  RealtimeTranscribeEvent,
  RealtimeVadEvent,
  RealtimeTranscriberCallbacks,
  RealtimeStatsEvent,
  RealtimeTranscriberDependencies,
  AudioStreamData,
  AudioSliceNoData,
  AudioStreamInterface,
  AudioStreamConfig,
  WhisperContextLike,
  WhisperVadContextLike,
} from './types'
import { VAD_PRESETS } from './types'

const SILENCE_SEGMENT_REGEX = /\[(\s*\w+\s*)]/i

/**
 * RealtimeTranscriber provides real-time audio transcription with VAD support.
 *
 * Features:
 * - Automatic slice management based on duration
 * - VAD-based speech detection and auto-slicing
 * - Configurable auto-slice mechanism that triggers on speech_end/silence events
 * - Memory management for audio slices
 * - Queue-based transcription processing
 */
export class RealtimeTranscriber {
  private whisperContext: WhisperContextLike

  private vadContext?: WhisperVadContextLike

  private audioStream: AudioStreamInterface

  private fs?: WavFileWriterFs

  private sliceManager: SliceManager

  private callbacks: RealtimeTranscriberCallbacks = {}

  private options: {
    audioSliceSec: number
    audioMinSec: number
    maxSlicesInMemory: number
    vadOptions: VadOptions
    vadPreset?: keyof typeof VAD_PRESETS
    autoSliceOnSpeechEnd: boolean
    autoSliceThreshold: number
    transcribeOptions: any
    initialPrompt?: string
    promptPreviousSlices: boolean
    audioOutputPath?: string
    audioStreamConfig?: AudioStreamConfig
    logger: (message: string) => void
    // VAD optimization options for low-end CPU
    vadThrottleMs: number // Minimum time between VAD calls (ms)
    vadSkipRatio: number // Skip every Nth slice (0 = no skipping)
    // Realtime transcription settings
    realtimeProcessingPauseSec: number
    initRealtimeAfterSec: number
    // VAD Performance Optimization
    preRecordingBufferSec: number
    energyThreshold: number
  }

  private isActive = false

  private isTranscribing = false

  private vadEnabled = false

  private isSpeechActive = false

  private transcriptionQueue: Array<{
    sliceIndex: number
    audioData: Uint8Array
    isFinal?: boolean
  }> = []



  private wavFileWriter: WavFileWriter | null = null

  // Simplified VAD state management
  private lastSpeechDetectedTime = 0

  // Track VAD state for proper event transitions


  // Track last stats to emit only when changed
  private lastStatsSnapshot: any = null

  // State management for silence duration
  private silenceStartTime = 0

  // Store transcription results by slice index
  private transcriptionResults: Map<
    number,
    { slice: AudioSliceNoData; transcribeEvent: RealtimeTranscribeEvent }
  > = new Map()

  // Store VAD events by slice index for inclusion in transcribe events
  private vadEvents: Map<number, RealtimeVadEvent> = new Map()

  // Ring buffer for pre-recording audio
  private preRecordingBuffer: RingBuffer

  constructor(
    dependencies: RealtimeTranscriberDependencies,
    options: RealtimeOptions = {},
    callbacks: RealtimeTranscriberCallbacks = {},
  ) {
    this.whisperContext = dependencies.whisperContext
    this.vadContext = dependencies.vadContext
    this.audioStream = dependencies.audioStream
    this.fs = dependencies.fs
    this.callbacks = callbacks

    // Set default options with proper types
    this.options = {
      audioSliceSec: options.audioSliceSec || 30,
      audioMinSec: options.audioMinSec || 1,
      maxSlicesInMemory: options.maxSlicesInMemory || 3,
      vadOptions: options.vadOptions || VAD_PRESETS.default,
      vadPreset: options.vadPreset,
      autoSliceOnSpeechEnd: options.autoSliceOnSpeechEnd || true,
      autoSliceThreshold: options.autoSliceThreshold || 0.5,
      transcribeOptions: options.transcribeOptions || {},
      initialPrompt: options.initialPrompt,
      promptPreviousSlices: options.promptPreviousSlices ?? true,
      audioOutputPath: options.audioOutputPath,
      logger: options.logger || (() => { }),
      // VAD optimization options for low-end CPU
      vadThrottleMs: options.vadThrottleMs ?? 1500, // Minimum time between VAD calls (ms)
      vadSkipRatio: options.vadSkipRatio ?? 0, // Skip every Nth slice (0 = no skipping)
      // Realtime transcription settings
      realtimeProcessingPauseSec: options.realtimeProcessingPauseSec ?? 0.2,
      initRealtimeAfterSec: options.initRealtimeAfterSec ?? 0.2,
      // VAD Performance Optimization
      preRecordingBufferSec: options.preRecordingBufferSec ?? 1.0,
      energyThreshold: options.energyThreshold ?? 0,
    }

    // Initialize RingBuffer
    const bufferSize = Math.floor(this.options.preRecordingBufferSec * 16000 * 2) // 16kHz, 16-bit
    this.preRecordingBuffer = new RingBuffer(bufferSize)

    // Apply VAD preset if specified
    if (this.options.vadPreset && VAD_PRESETS[this.options.vadPreset]) {
      this.options.vadOptions = {
        ...VAD_PRESETS[this.options.vadPreset],
        ...this.options.vadOptions,
      }
    }

    // Enable VAD if context is provided and not explicitly disabled
    this.vadEnabled = !!this.vadContext

    // Initialize managers
    this.sliceManager = new SliceManager(
      this.options.audioSliceSec,
      this.options.maxSlicesInMemory,
    )

    // Set up audio stream callbacks
    this.audioStream.onData(this.handleAudioData.bind(this))
    this.audioStream.onError(this.handleError.bind(this))
    this.audioStream.onStatusChange(this.handleAudioStatusChange.bind(this))
  }

  /**
   * Start realtime transcription
   */
  async start(): Promise<void> {
    if (this.isActive) {
      throw new Error('Realtime transcription is already active')
    }

    try {
      this.isActive = true
      this.callbacks.onStatusChange?.(true)

      // Reset all state to ensure clean start
      this.reset()

      // Initialize WAV file writer if output path is specified
      if (this.fs && this.options.audioOutputPath) {
        this.wavFileWriter = new WavFileWriter(
          this.fs,
          this.options.audioOutputPath,
          {
            sampleRate: this.options.audioStreamConfig?.sampleRate || 16000,
            channels: this.options.audioStreamConfig?.channels || 1,
            bitsPerSample: this.options.audioStreamConfig?.bitsPerSample || 16,
          },
        )
        await this.wavFileWriter.initialize()
      }

      // Start audio recording
      await this.audioStream.initialize({
        sampleRate: this.options.audioStreamConfig?.sampleRate || 16000,
        channels: this.options.audioStreamConfig?.channels || 1,
        bitsPerSample: this.options.audioStreamConfig?.bitsPerSample || 16,
        audioSource: this.options.audioStreamConfig?.audioSource || 6,
        bufferSize: this.options.audioStreamConfig?.bufferSize || 16 * 1024,
      })
      await this.audioStream.start()

      // Emit stats update for status change
      this.emitStatsUpdate('status_change')

      this.log('Realtime transcription started')
    } catch (error) {
      this.isActive = false
      this.callbacks.onStatusChange?.(false)
      throw error
    }
  }

  /**
   * Stop realtime transcription
   */
  async stop(): Promise<void> {
    if (!this.isActive) {
      return
    }

    try {
      this.isActive = false

      // Stop audio recording
      await this.audioStream.stop()

      // Process any remaining queued transcriptions
      await this.processTranscriptionQueue()

      // Finalize WAV file
      if (this.wavFileWriter) {
        await this.wavFileWriter.finalize()
        this.wavFileWriter = null
      }

      // Reset all state completely
      this.reset()

      this.callbacks.onStatusChange?.(false)

      // Emit stats update for status change
      this.emitStatsUpdate('status_change')

      this.log('Realtime transcription stopped')
    } catch (error) {
      this.handleError(`Stop error: ${error}`)
    }
  }

  /**
   * Handle incoming audio data
   */
  private handleAudioData(streamData: AudioStreamData): void {
    if (!this.isActive) return

    this.processAudioChunk(streamData.data).catch((error) => {
      this.handleError(`Audio processing error: ${error}`)
    })

    // Write to WAV file if enabled
    if (this.wavFileWriter) {
      this.wavFileWriter.appendAudioData(streamData.data).catch((error) => {
        this.log(`Failed to write audio to WAV file: ${error}`)
      })
    }
  }

  /**
   * Process audio chunk through the VAD pipeline
   */
  private async processAudioChunk(data: Uint8Array): Promise<void> {
    // 1. Push to Ring Buffer
    this.preRecordingBuffer.write(data)

    // 2. Pre-VAD Filter
    if (this.callbacks.onBeginVad) {
      const { sampleRate = 16000 } = this.options.audioStreamConfig || {}
      const duration = (data.length / 2) / (sampleRate / 1000) // ms

      const shouldContinue = await this.callbacks.onBeginVad({
        audioData: data,
        sliceIndex: -1, // No slice index yet for raw chunks
        duration,
      })

      if (!shouldContinue) {
        // User cancelled VAD for this chunk
        return
      }
    }

    // 3. Fast Energy Estimate
    if (this.options.energyThreshold > 0) {
      const rms = this.calculateRMS(data)
      if (rms < this.options.energyThreshold) {
        // Silence, skip expensive VAD
        await this.handleVADStateChange(0, data)
        return
      }
    }

    // 3. VAD from Ring Buffer (using 1.0s context)
    let speechRate = 0
    try {
      if (this.vadContext) {
        const vadInput = this.preRecordingBuffer.read()
        if (vadInput.byteLength > 0) {
          const vadInputBuffer = vadInput.buffer as ArrayBuffer
          const segments = await this.vadContext.detectSpeechData(
            vadInputBuffer,
            this.options.vadOptions
          )
          // calc prob from t0 ~ t1 cover rate
          const audioLength = vadInput.byteLength / 2 / (this.options.audioStreamConfig?.sampleRate || 16000)
          // t0/t1 is 10ms unit
          speechRate = segments.reduce((acc, { t0, t1 }) => acc + (t1 - t0) / 100, 0) / audioLength
        }
      } else {
        // If VAD is disabled or unavailable, assume speech if active
        speechRate = 1
      }
    } catch (error) {
      this.log(`VAD error: ${error}`)
    }

    // 4. Switch VAD State
    await this.handleVADStateChange(speechRate, data)
  }

  /**
   * Calculate RMS energy of audio chunk
   */
  private calculateRMS(data: Uint8Array): number {
    if (data.length === 0) return 0

    // Convert to Int16 samples
    const sampleCount = data.length / 2
    let sumSquares = 0

    // Process 2 bytes at a time (little endian)
    for (let i = 0; i < data.length - 1; i += 2) {
      const low = data[i] as number
      const high = data[i + 1] as number
      // eslint-disable-next-line no-bitwise
      const sample = (high << 8) | low
      // Check for sign (16-bit signed)
      // eslint-disable-next-line no-bitwise
      const signedSample = sample >= 0x8000 ? sample - 0x10000 : sample
      // Normalize to -1.0 to 1.0 range
      const normalized = signedSample / 32768.0
      sumSquares += normalized ** 2
    }

    return Math.sqrt(sumSquares / sampleCount)
  }

  /**
   * Handle state transitions based on VAD result
   */
  private async handleVADStateChange(speechRate: number, data: Uint8Array): Promise<void> {
    const isRecording = this.isSpeechActive
    const threshold = this.options.vadOptions?.threshold || 0.5

    if (speechRate > threshold) {
      this.silenceStartTime = 0 // Reset silence counter

      if (!isRecording) {
        // === START RECORDING ===
        this.log('VAD: Speech Start detected')
        this.isSpeechActive = true

        // 5a. Create slice with RingBuffer (Pre-roll)
        const preRoll = this.preRecordingBuffer.read()

        // Reset SliceManager logic to start fresh?
        // We assume addAudioData handles appending to "current" slice.
        // We want to force a new logical segment if we were just 'listening'.
        // But SliceManager wraps 30s slices. We just feed it.
        // Important: preRoll contains [Old...New].
        this.sliceManager.addAudioData(preRoll)

        this.emitVadEvent('speech_start')
      } else {
        // === CONTINUE RECORDING ===
        // 5b. Append raw data directly (not from RingBuffer)
        this.sliceManager.addAudioData(data)

        this.emitVadEvent('speech_continue')

        // 6. Transcribe (Partial)
        this.triggerTranscription(false)
      }
    } else {
      // Silence detected
      // eslint-disable-next-line no-lonely-if
      if (isRecording) {
        // Check for silence timeout (Hysteresis)
        if (this.silenceStartTime === 0) {
          this.silenceStartTime = Date.now()
        }

        const silenceDuration = (Date.now() - this.silenceStartTime) / 1000

        // Resolve min silence duration from VAD options or presets
        const vadSilenceMs = this.options.vadOptions.minSilenceDurationMs

        // Use VAD setting if available, otherwise audioMinSec, default 0.5s
        const minDuration = vadSilenceMs !== undefined
          ? vadSilenceMs / 1000
          : this.options.audioMinSec

        if (silenceDuration > minDuration) {

          // === END RECORDING ===
          this.log(`VAD: Speech End detected (Silence: ${silenceDuration.toFixed(2)}s)`)
          this.isSpeechActive = false

          // Append final chunk
          this.sliceManager.addAudioData(data)

          this.emitVadEvent('speech_end')
          await this.nextSlice()
        } else {
          // Still recording (Silence Gap)
          this.sliceManager.addAudioData(data)
          // We might want to transcribe here too to capture the gap?
          this.triggerTranscription(false)
        }
      } else {
        // Listening... Silence...
        this.emitVadEvent('silence')
      }
    }
  }

  /**
   * Trigger transcription for the current slice
   */
  private triggerTranscription(isFinal: boolean): void {
    const sliceInfo = this.sliceManager.getCurrentSliceInfo()
    const slice = this.sliceManager.getSliceByIndex(sliceInfo.currentSliceIndex)

    if (!slice || slice.sampleCount === 0) return

    // Queue transcription
    const audioData = this.sliceManager.getAudioDataForTranscription(slice.index)
    if (audioData) {
      this.transcriptionQueue.push({
        sliceIndex: slice.index,
        audioData,
        isFinal // Pass flag to processTranscription (need update)
      })
      this.processTranscriptionQueue().catch(e => this.handleError(e))
    }
  }

  private emitVadEvent(type: RealtimeVadEvent['type']): void {
    const sliceInfo = this.sliceManager.getCurrentSliceInfo()
    const event: RealtimeVadEvent = {
      type,
      timestamp: Date.now(),
      sliceIndex: sliceInfo.currentSliceIndex,
      confidence: 1.0,
      lastSpeechDetectedTime: -1,
      duration: this.sliceManager.getSliceByIndex(sliceInfo.currentSliceIndex)?.data.length ? this.sliceManager.getSliceByIndex(sliceInfo.currentSliceIndex)!.data.length / 32000 : 0
    }
    this.vadEvents.set(sliceInfo.currentSliceIndex, event)
    this.callbacks.onVad?.(event)
  }

  private isProcessingTranscriptionQueue = false

  private processingPromise: Promise<void> | null = null

  /**
   * Process the transcription queue
   */
  private async processTranscriptionQueue(): Promise<void> {
    if (this.isProcessingTranscriptionQueue && this.processingPromise) {
      return this.processingPromise
    }

    this.isProcessingTranscriptionQueue = true

    this.processingPromise = (async () => {
      while (this.transcriptionQueue.length > 0) {
        const item = this.transcriptionQueue.shift() // shift() modifies the array
        if (item) {
          // eslint-disable-next-line no-await-in-loop
          await this.processTranscription(item).catch((error) => {
            this.handleError(`Transcription error: ${error}`)
          })
        }
      }
      this.isProcessingTranscriptionQueue = false
      this.processingPromise = null
    })()

    return this.processingPromise
  }

  /**
   * Build prompt from initial prompt and previous slices
   */
  private buildPrompt(currentSliceIndex: number): string | undefined {
    const promptParts: string[] = []

    // Add initial prompt if provided
    if (this.options.initialPrompt) {
      promptParts.push(this.options.initialPrompt)
    }

    // Add previous slice results if enabled
    if (this.options.promptPreviousSlices) {
      // Get transcription results from previous slices (up to the current slice)
      const previousResults = Array.from(this.transcriptionResults.entries())
        .filter(([sliceIndex]) => sliceIndex < currentSliceIndex)
        .sort(([a], [b]) => a - b) // Sort by slice index
        .map(([, result]) => result.transcribeEvent.data?.result)
        .filter((result): result is string => Boolean(result)) // Filter out empty results with type guard

      if (previousResults.length > 0) {
        promptParts.push(...previousResults)
      }
    }

    return promptParts.join(' ') || undefined
  }

  /**
   * Process a single transcription
   */
  private async processTranscription(item: {
    sliceIndex: number
    audioData: Uint8Array
    isFinal?: boolean
  }): Promise<void> {
    if (!this.isActive) {
      return
    }

    this.isTranscribing = true

    // Emit stats update for status change
    this.emitStatsUpdate('status_change')

    const startTime = Date.now()

    try {
      // Build prompt from initial prompt and previous slices
      const prompt = this.buildPrompt(item.sliceIndex)

      const audioBuffer = item.audioData.buffer as ArrayBuffer
      const { promise } = this.whisperContext.transcribeData(audioBuffer, {
        ...this.options.transcribeOptions,
        prompt, // Include the constructed prompt
        onProgress: undefined, // Disable progress for realtime
      })

      const result = await promise
      const endTime = Date.now()

      // Normalize result and segments, remove "[ silence ]" or "[BLANK]"
      result.result = result.result.replace(SILENCE_SEGMENT_REGEX, '').trim()

      const slice = this.sliceManager.getSliceByIndex(item.sliceIndex)
      if (!slice) {
        this.log(`Slice not found for index ${item.sliceIndex}, skipping transcription processing.`)
        return
      }

      // Check if user wants to filter this transcription
      if (this.callbacks.onBeginTranscribe) {
        const { sampleRate = 16000 } = this.options.audioStreamConfig || {}
        const duration = (item.audioData.length / 2) / (sampleRate / 1000) // ms

        const shouldContinue = await this.callbacks.onBeginTranscribe({
          audioData: item.audioData,
          sliceIndex: slice.index,
          duration,
          vadEvent: this.vadEvents.get(item.sliceIndex)
        })

        if (!shouldContinue) {
          this.log(`Transcription filtered by onBeginTranscribe for slice ${slice.index}`)
          return
        }
      }

      // Create new transcription event
      const { sampleRate = 16000 } = this.options.audioStreamConfig || {}
      const transcribeEvent: RealtimeTranscribeEvent = {
        type: 'transcribe',
        sliceIndex: item.sliceIndex,
        data: result,
        isCapturing: this.audioStream.isRecording(),
        processTime: endTime - startTime,
        recordingTime: item.audioData.length / (sampleRate / 1000) / 2, // ms,
        memoryUsage: this.sliceManager.getMemoryUsage(),
        vadEvent: this.vadEvents.get(item.sliceIndex),
      }

      // if the current result is invalid, use the previous result
      const previousTranscribe = this.transcriptionResults.get(item.sliceIndex)
        ?.transcribeEvent
      if (previousTranscribe && result.result.trim() === '.') {
        transcribeEvent.data = previousTranscribe.data
      }

      // Save transcription results
      if (slice) {
        this.transcriptionResults.set(item.sliceIndex, {
          slice: {
            // Don't keep data in the slice
            index: slice.index,
            sampleCount: slice.sampleCount,
            startTime: slice.startTime,
            endTime: slice.endTime,
            isProcessed: slice.isProcessed,
            isReleased: slice.isReleased,
          },
          transcribeEvent,
        })
      }

      // Emit transcribe event
      this.callbacks.onTranscribe?.(transcribeEvent)

      // Feed result to stabilizer for realtime updates
      // Only stabilize final results (speech_end) to match legacy behavior
      const resultText = result.result?.trim() || ''
      if (item.isFinal) {
        this.callbacks.onSliceTranscriptionStabilized?.(resultText)
        this.vadEvents.delete(item.sliceIndex)
      }

      // Emit stats update for memory/slice changes
      this.emitStatsUpdate('memory_change')

      this.log(
        `Transcribed speech segment ${item.sliceIndex} (Final=${!!item.isFinal}): "${result.result}"`,
      )
    } catch (error) {
      // ... error handling ...
      this.handleError(`Transcription error: ${error}`)
    } finally {
      if (this.transcriptionQueue.length === 0) {
        this.isTranscribing = false
      }
    }
  }

  /**
   * Handle audio status changes
   */
  private handleAudioStatusChange(isRecording: boolean): void {
    this.log(`Audio recording: ${isRecording ? 'started' : 'stopped'}`)
  }

  /**
   * Handle errors from components
   */
  private handleError(error: string): void {
    this.log(`Error: ${error}`)
    this.callbacks.onError?.(error)
  }

  /**
   * Update callbacks
   */
  updateCallbacks(callbacks: Partial<RealtimeTranscriberCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks }
  }

  /**
   * Update VAD options dynamically
   */
  updateVadOptions(options: Partial<VadOptions>): void {
    this.options.vadOptions = { ...this.options.vadOptions, ...options }
  }

  /**
   * Update auto-slice options dynamically
   */
  updateAutoSliceOptions(options: {
    autoSliceOnSpeechEnd?: boolean
    autoSliceThreshold?: number
  }): void {
    if (options.autoSliceOnSpeechEnd !== undefined) {
      this.options.autoSliceOnSpeechEnd = options.autoSliceOnSpeechEnd
    }
    if (options.autoSliceThreshold !== undefined) {
      this.options.autoSliceThreshold = options.autoSliceThreshold
    }
    this.log(
      `Auto-slice options updated: enabled=${this.options.autoSliceOnSpeechEnd}, threshold=${this.options.autoSliceThreshold}`,
    )
  }

  /**
   * Update VAD throttling options dynamically for low-end CPU optimization
   */
  updateVadThrottleOptions(options: {
    vadThrottleMs?: number
    vadSkipRatio?: number
  }): void {
    if (options.vadThrottleMs !== undefined) {
      this.options.vadThrottleMs = options.vadThrottleMs
    }
    if (options.vadSkipRatio !== undefined) {
      this.options.vadSkipRatio = options.vadSkipRatio
    }
    this.log(
      `VAD throttle options updated: throttleMs=${this.options.vadThrottleMs}, skipRatio=${this.options.vadSkipRatio}`,
    )
  }

  /**
   * Get current statistics
   */
  getStatistics() {
    return {
      isActive: this.isActive,
      isTranscribing: this.isTranscribing,
      vadEnabled: this.vadEnabled,
      audioStats: {
        isRecording: this.audioStream.isRecording(),
        accumulatedSamples: 0, // No longer tracked
      },
      vadStats: this.vadEnabled
        ? {
          enabled: true,
          contextAvailable: !!this.vadContext,
          lastSpeechDetectedTime: this.lastSpeechDetectedTime,
          isProcessing: false,
          queueSize: 0,
          skippedCount: 0,
          throttleMs: this.options.vadThrottleMs,
          skipRatio: this.options.vadSkipRatio,
        }
        : null,
      sliceStats: this.sliceManager.getCurrentSliceInfo(),
      autoSliceConfig: {
        enabled: this.options.autoSliceOnSpeechEnd,
        threshold: this.options.autoSliceThreshold,
        targetDuration: this.options.audioSliceSec,
        minDuration: this.options.audioMinSec,
      },
    }
  }

  /**
   * Get all transcription results
   */
  getTranscriptionResults(): Array<{
    slice: AudioSliceNoData
    transcribeEvent: RealtimeTranscribeEvent
  }> {
    return Array.from(this.transcriptionResults.values())
  }

  /**
   * Force move to the next slice, finalizing the current one regardless of capacity
   */
  async nextSlice(): Promise<void> {
    if (!this.isActive) {
      this.log('Cannot force next slice - transcriber is not active')
      return
    }

    // Emit start event to indicate slice processing has started
    const startEvent: RealtimeTranscribeEvent = {
      type: 'start',
      sliceIndex: -1, // Use -1 to indicate forced slice
      data: undefined,
      isCapturing: this.audioStream.isRecording(),
      processTime: 0,
      recordingTime: 0,
      memoryUsage: this.sliceManager.getMemoryUsage(),
    }

    this.callbacks.onTranscribe?.(startEvent)

    // Check if there are pending transcriptions or currently transcribing
    if (this.isTranscribing || this.transcriptionQueue.length > 0) {
      this.log(
        'Waiting for pending transcriptions to complete before forcing next slice...',
      )

      // Wait for current transcription queue to be processed
      await this.processTranscriptionQueue()
    }

    const result = this.sliceManager.forceNextSlice()

    if (result.slice) {
      this.log(
        `Forced slice ${result.slice.index} ready (${result.slice.data.length} bytes)`,
      )

      // Queue for transcription (Final)
      if (result.slice.data.length > 0) {
        this.transcriptionQueue.push({
          sliceIndex: result.slice.index,
          audioData: result.slice.data,
          isFinal: true
        })
        this.processTranscriptionQueue().catch((error) => {
          this.handleError(`Failed to process forced slice: ${error}`)
        })
      }

      this.emitStatsUpdate('memory_change')
    } else {
      this.log('Forced next slice but no slice data to process')
    }
  }

  /**
   * Reset all components
   */
  reset(): void {
    this.sliceManager.reset()
    this.transcriptionQueue = []
    this.isTranscribing = false

    // Reset VAD state
    this.lastSpeechDetectedTime = -1
    this.silenceStartTime = 0

    // Reset stats snapshot for clean start
    this.lastStatsSnapshot = null

    // Cancel WAV file writing if in progress
    if (this.wavFileWriter) {
      this.wavFileWriter.cancel().catch((error) => {
        this.log(`Failed to cancel WAV file writing: ${error}`)
      })
      this.wavFileWriter = null
    }

    // Clear transcription results
    this.transcriptionResults.clear()

    // Clear VAD events
    this.vadEvents.clear()

    this.isSpeechActive = false

    // Clear pre-recording buffer
    if (this.preRecordingBuffer) {
      this.preRecordingBuffer.clear()
    }
  }

  /**
   * Release all resources
   */
  async release(): Promise<void> {
    if (this.isActive) {
      await this.stop()
    }

    await this.audioStream.release()
    await this.wavFileWriter?.finalize()
    this.vadContext = undefined
  }

  /**
   * Emit stats update event if stats have changed significantly
   */
  private emitStatsUpdate(eventType: RealtimeStatsEvent['type']): void {
    const currentStats = this.getStatistics()

    // Check if stats have changed significantly
    if (
      !this.lastStatsSnapshot ||
      RealtimeTranscriber.shouldEmitStatsUpdate(
        currentStats,
        this.lastStatsSnapshot,
      )
    ) {
      const statsEvent: RealtimeStatsEvent = {
        timestamp: Date.now(),
        type: eventType,
        data: currentStats,
      }

      this.callbacks.onStatsUpdate?.(statsEvent)
      this.lastStatsSnapshot = { ...currentStats }
    }
  }

  /**
   * Determine if stats update should be emitted
   */
  private static shouldEmitStatsUpdate(current: any, previous: any): boolean {
    // Always emit on status changes
    if (
      current.isActive !== previous.isActive ||
      current.isTranscribing !== previous.isTranscribing
    ) {
      return true
    }

    // Emit on significant memory changes (>10% or >5MB)
    const currentMemory = current.sliceStats?.memoryUsage?.estimatedMB || 0
    const previousMemory = previous.sliceStats?.memoryUsage?.estimatedMB || 0
    const memoryDiff = Math.abs(currentMemory - previousMemory)

    if (
      memoryDiff > 5 ||
      (previousMemory > 0 && memoryDiff / previousMemory > 0.1)
    ) {
      return true
    }

    return false
  }

  /**
   * Logger function
   */
  private log(message: string): void {
    this.options.logger(`[RealtimeTranscriber] ${message}`)
  }
}
