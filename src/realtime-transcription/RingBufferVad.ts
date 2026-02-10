
import { RingBuffer } from './RingBuffer'

import type { RealtimeVadContextLike, WhisperVadContextLike } from './types'
import { VAD_PRESETS } from './types'
import type { VadOptions } from '../index'

export type RingBufferVadOptions = {
    vadOptions?: VadOptions
    vadPreset?: keyof typeof VAD_PRESETS
    preRecordingBufferMs?: number
    sampleRate?: number
    inferenceIntervalMs?: number
    speechRateThreshold?: number
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

    private vadInferenceQueue: Array<() => Promise<void>> = []

    private isProcessingVad = false

    private speechDetectedCallback: ((confidence: number, data: ArrayBuffer) => Promise<void>) | null = null

    private speechEndedCallback: ((confidence: number) => Promise<void>) | null = null

    private errorCallback: ((error: string) => void) | null = null

    private chunkAccumulated: number = 0

    private targetChunkSize: number

    constructor(
        vadContext: WhisperVadContextLike,
        options: RingBufferVadOptions = {}
    ) {
        this.vadContext = vadContext
        this.options = {
            vadOptions: options.vadOptions || VAD_PRESETS.default,
            vadPreset: options.vadPreset,
            preRecordingBufferMs: options.preRecordingBufferMs ?? 1000,
            sampleRate: options.sampleRate || 16000,
            inferenceIntervalMs: options.inferenceIntervalMs || 500,
            speechRateThreshold: options.speechRateThreshold || 0.3,
            logger: options.logger || (() => { })
        }

        // Apply preset
        if (this.options.vadPreset && VAD_PRESETS[this.options.vadPreset]) {
            this.options.vadOptions = {
                ...VAD_PRESETS[this.options.vadPreset],
                ...this.options.vadOptions
            }
        }

        // Check preRecordingBufferSec should > inferenceIntervalMs
        if (this.options.preRecordingBufferMs! < this.options.inferenceIntervalMs!) {
            throw new Error('preRecordingBufferMs must be greater than inferenceIntervalMs')
        }

        // Initialize RingBuffer
        const bufferSize = Math.floor((this.options.preRecordingBufferMs!) * (this.options.sampleRate!) * 2) // 16-bit samples
        this.ringBuffer = new RingBuffer(bufferSize)

        this.targetChunkSize = Math.floor((this.options.inferenceIntervalMs! / 1000) * (this.options.sampleRate!) * 2)
    }

    onSpeechStart(callback: (confidence: number, data: ArrayBuffer) => Promise<void>): void {
        this.speechDetectedCallback = callback
    }

    onSpeechEnd(callback: (confidence: number) => Promise<void>): void {
        this.speechEndedCallback = callback
    }

    onError(callback: (error: string) => void): void {
        this.errorCallback = callback
    }

    processAudio(data: ArrayBuffer): void {
        const u8Data = new Uint8Array(data)

        // 1. Push to Ring Buffer
        this.ringBuffer.write(u8Data)

        this.chunkAccumulated += u8Data.byteLength

        // 2. Run VAD
        if (this.chunkAccumulated >= this.targetChunkSize) {
            this.chunkAccumulated = 0
            const vadPromise = this.processVad()
            this.activeVadPromises.add(vadPromise)

            vadPromise.finally(() => {
                this.activeVadPromises.delete(vadPromise)
            })
        }
    }

    async flush(): Promise<void> {
        // Force process last chunk if any
        if (this.chunkAccumulated > 0) {
            const vadPromise = this.processVad()
            this.activeVadPromises.add(vadPromise)

            vadPromise.finally(() => {
                this.activeVadPromises.delete(vadPromise)
            })
        }
        // Wait for any active VAD processing to finish
        await Promise.allSettled([...this.activeVadPromises])
    }

    async reset(): Promise<void> {
        await this.flush()
        this.activeVadPromises.clear()
        this.vadInferenceQueue.length = 0
        this.isProcessingVad = false
        this.ringBuffer.clear()
        this.chunkAccumulated = 0
        this.isSpeechActive = false
        this.silenceStartTime = 0
        this.currentSpeechStartTime = 0
    }

    private async processVad(): Promise<void> {
        return new Promise((resolve) => {
            // Enqueue the VAD task
            this.vadInferenceQueue.push(async () => {
                let lastSpeechOffset = -1
                let speechRate = 0
                let vadInput: Uint8Array
                try {
                    vadInput = this.ringBuffer.read()
                    if (vadInput.byteLength > 0) {
                        const vadInputBuffer = vadInput.buffer as ArrayBuffer

                        // This is now guaranteed to run sequentially
                        const segments = await this.vadContext.detectSpeechData(
                            vadInputBuffer,
                            this.options.vadOptions!
                        )

                        const audioLength = vadInput.byteLength / 2 / (this.options.sampleRate || 16000)
                        // t0/t1 is 10ms unit
                        speechRate = segments.reduce((acc, { t0, t1 }) => acc + (t1 - t0) / 100, 0) / audioLength
                        lastSpeechOffset = segments.length > 0 ? segments[segments.length - 1]!.t1 * 10 : -1
                    }
                } catch (error: any) {
                    this.log(`VAD error: ${error}`)
                    this.errorCallback?.(`VAD processing error: ${error.message || error}`)
                    resolve()
                    return
                }

                await this.handleVadStateChange(lastSpeechOffset, speechRate, vadInput)
                resolve()
            })

            // Start processing the queue
            this.processVadQueue()
        })
    }

    private async processVadQueue(): Promise<void> {
        // If already processing, return (the current processor will handle the queue)
        if (this.isProcessingVad) {
            return
        }

        this.isProcessingVad = true

        while (this.vadInferenceQueue.length > 0) {
            const task = this.vadInferenceQueue.shift()
            if (task) {
                await task() // eslint-disable-line no-await-in-loop
            }
        }

        this.isProcessingVad = false
    }

    private async handleVadStateChange(lastSpeechOffset: number, speechRate: number, currentData: Uint8Array): Promise<void> {
        const timeOffset = (this.options.preRecordingBufferMs!) - lastSpeechOffset
        const minSpeechDurationMs = this.options.vadOptions?.minSpeechDurationMs || 100

        // Logic ported from RealtimeTranscriber.ts
        if (speechRate > this.options.speechRateThreshold!) {
            this.silenceStartTime = 0

            if (!this.isSpeechActive) {
                // Speech Start
                this.isSpeechActive = true
                this.currentSpeechStartTime = Date.now() - timeOffset
                await this.speechDetectedCallback?.(speechRate, currentData.buffer as ArrayBuffer)
            } else {
                // Speech Continue
                // Check max duration
                const maxDurationS = this.options.vadOptions?.maxSpeechDurationS || 30
                const currentDurationMs = Date.now() - this.currentSpeechStartTime

                if (currentDurationMs > maxDurationS * 1000) {
                    this.isSpeechActive = false
                    await this.speechEndedCallback?.(1.0)

                    // Immediately restart
                    this.isSpeechActive = true
                    this.currentSpeechStartTime = Date.now()
                    await this.speechDetectedCallback?.(speechRate, currentData.buffer as ArrayBuffer)
                }
            }
        } else if (this.isSpeechActive && (Date.now() - this.currentSpeechStartTime) > minSpeechDurationMs) { // Silence
            if (this.silenceStartTime === 0) {
                this.silenceStartTime = Date.now() + timeOffset
            }

            const silenceDuration = (Date.now() - this.silenceStartTime) / 1000
            const minSilenceDurationMs = this.options.vadOptions?.minSilenceDurationMs || 100

            if (silenceDuration > minSilenceDurationMs / 1000) {
                this.isSpeechActive = false
                this.silenceStartTime = 0
                await this.speechEndedCallback?.(1 - speechRate)
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
