
import { RingBuffer } from './RingBuffer'

import type { RealtimeVadContextLike, WhisperVadContextLike } from './types'
import { VAD_PRESETS } from './types'
import type { VadOptions } from '../index'

export type RingBufferVadOptions = {
    vadOptions?: VadOptions
    vadPreset?: keyof typeof VAD_PRESETS
    preRecordingBufferSec?: number
    sampleRate?: number
    logger?: (message: string) => void
}

export class RingBufferVad implements RealtimeVadContextLike {
    private vadContext: WhisperVadContextLike

    private ringBuffer: RingBuffer

    private options: RingBufferVadOptions

    private isSpeechActive = false

    private silenceStartTime = 0

    private currentSpeechStartTime = 0

    private activeVadPromises: Set<Promise<any>> = new Set()

    private speechDetectedCallback: ((data: ArrayBuffer) => Promise<void>) | null = null

    private speechEndedCallback: ((data: ArrayBuffer) => Promise<void>) | null = null

    private errorCallback: ((error: string) => void) | null = null

    constructor(
        vadContext: WhisperVadContextLike,
        options: RingBufferVadOptions = {}
    ) {
        this.vadContext = vadContext
        this.options = {
            vadOptions: options.vadOptions || VAD_PRESETS.default,
            vadPreset: options.vadPreset,
            preRecordingBufferSec: options.preRecordingBufferSec ?? 1.0,
            sampleRate: options.sampleRate || 16000,
            logger: options.logger || (() => { })
        }

        // Apply preset
        if (this.options.vadPreset && VAD_PRESETS[this.options.vadPreset]) {
            this.options.vadOptions = {
                ...VAD_PRESETS[this.options.vadPreset],
                ...this.options.vadOptions
            }
        }

        // Initialize RingBuffer
        const bufferSize = Math.floor((this.options.preRecordingBufferSec!) * (this.options.sampleRate!) * 2) // 16-bit samples
        this.ringBuffer = new RingBuffer(bufferSize)
    }

    onSpeechStart(callback: (data: ArrayBuffer) => Promise<void>): void {
        this.speechDetectedCallback = callback
    }

    onSpeechEnd(callback: (data: ArrayBuffer) => Promise<void>): void {
        this.speechEndedCallback = callback
    }

    onError(callback: (error: string) => void): void {
        this.errorCallback = callback
    }

    processAudio(data: ArrayBuffer): void {
        const u8Data = new Uint8Array(data)

        // 1. Push to Ring Buffer
        this.ringBuffer.write(u8Data)

        // 2. Run VAD
        const vadPromise = this.processVad(data)
        this.activeVadPromises.add(vadPromise)

        vadPromise.finally(() => {
            this.activeVadPromises.delete(vadPromise)
        })
    }

    async flush(): Promise<void> {
        // Wait for any active VAD processing to finish
        await Promise.allSettled([...this.activeVadPromises])
    }

    async reset(): Promise<void> {
        await this.flush()
        this.activeVadPromises.clear()
        this.ringBuffer.clear()
        this.isSpeechActive = false
        this.silenceStartTime = 0
        this.currentSpeechStartTime = 0
    }

    private async processVad(currentData: ArrayBuffer): Promise<void> {
        let speechRate = 0
        try {
            const vadInput = this.ringBuffer.read()
            if (vadInput.byteLength > 0) {
                const vadInputBuffer = vadInput.buffer as ArrayBuffer

                const segments = await this.vadContext.detectSpeechData(
                    vadInputBuffer,
                    this.options.vadOptions!
                )

                const audioLength = vadInput.byteLength / 2 / (this.options.sampleRate || 16000)
                // t0/t1 is 10ms unit
                speechRate = segments.reduce((acc, { t0, t1 }) => acc + (t1 - t0) / 100, 0) / audioLength
            }
        } catch (error: any) {
            this.log(`VAD error: ${error}`)
            this.errorCallback?.(`VAD processing error: ${error.message || error}`)
            return
        }

        await this.handleVadStateChange(speechRate, new Uint8Array(currentData))
    }

    private async handleVadStateChange(speechRate: number, currentData: Uint8Array): Promise<void> {
        const threshold = this.options.vadOptions?.threshold || 0.5

        // Logic ported from RealtimeTranscriber.ts
        if (speechRate > threshold) {
            this.silenceStartTime = 0

            if (!this.isSpeechActive) {
                // Speech Start
                this.isSpeechActive = true
                this.log('Speech detected')

                // Read from RingBuffer (pre-roll)
                const preRoll = this.ringBuffer.read()
                this.currentSpeechStartTime = Date.now() - (this.options.preRecordingBufferSec! * 1000)

                await this.speechDetectedCallback?.(preRoll.buffer as ArrayBuffer)
            } else {
                // Speech Continue
                // Check max duration
                const maxDurationS = this.options.vadOptions?.maxSpeechDurationS || 30
                const currentDurationMs = Date.now() - this.currentSpeechStartTime

                if (currentDurationMs > maxDurationS * 1000) {
                    this.log('Max speech duration exceeded')
                    this.isSpeechActive = false

                    await this.speechEndedCallback?.(new ArrayBuffer(0))

                    // Immediately restart
                    this.isSpeechActive = true
                    this.currentSpeechStartTime = Date.now()

                    await this.speechDetectedCallback?.(currentData.buffer as ArrayBuffer)
                }
            }
        } else if (this.isSpeechActive) { // Silence
            if (this.silenceStartTime === 0) {
                this.silenceStartTime = Date.now()
            }

            const silenceDuration = (Date.now() - this.silenceStartTime) / 1000
            const minSilenceDurationMs = this.options.vadOptions?.minSilenceDurationMs || 100

            if (silenceDuration > minSilenceDurationMs / 1000) {
                this.isSpeechActive = false
                this.silenceStartTime = 0

                // Pass empty buffer as state signal
                await this.speechEndedCallback?.(new ArrayBuffer(0))
            }
        }
    }

    private log(message: string) {
        this.options.logger?.(`[RingBufferVad] ${message}`)
    }

    // Helper to update options
    updateOptions(options: Partial<VadOptions>) {
        this.options.vadOptions = { ...this.options.vadOptions, ...options }
    }
}
