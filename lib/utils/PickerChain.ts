/**
 * Chain-capture controller: drives the pick → send → new-context →
 * auto-reopen-picker loop so an entire vision job is two button presses
 * (tap image, tap OK).
 *
 * Kept as a standalone state machine (no React, no Expo imports) so the
 * Android-hardness cases can be unit-tested off-device:
 *
 * - RELAUNCH TIMING: Android cannot reliably start a new picker activity from
 *   inside the previous picker's result continuation — the host activity may
 *   not be resumed yet (expo's ActivityResultsManager can also still hold the
 *   finishing contract). The relaunch is therefore DEFERRED by
 *   `relaunchDelayMs`, and a launch throw (e.g. MissingCurrentActivityException
 *   or "different picking in progress") is retried once after `retryDelayMs`
 *   before the chain gives up.
 * - CANCEL IS THE EXIT: the picker's back/cancel press is the only way the
 *   user leaves the loop — a canceled pick must NEVER relaunch.
 * - NO RE-ENTRANCY: a chain step never starts while a pick is in flight
 *   (double-taps on the attach button, timer racing a manual press).
 * - NO RECURSION: each step is scheduled through a timer, so arbitrarily long
 *   sessions cannot grow the call stack.
 * - FAILURE STOPS THE CHAIN: a blocked send (single-image guard), a failed
 *   dispatch, or a second launch failure ends the loop instead of spinning.
 * - DISPOSE ON UNMOUNT: leaving the chat screen cancels any scheduled step.
 */

export type ChainPickOutcome =
    /** picked + auto-send dispatched — the chain may continue */
    | 'sent'
    /** user canceled the picker — ALWAYS stops the chain */
    | 'canceled'
    /** picked but nothing was sent (guard refused / auto-send off) — stops */
    | 'blocked'
    /** picked and attached without sending (send-on-attach disabled) — stops */
    | 'attached'

export type PickerChainOptions = {
    /** Delay before a chained relaunch (activity settle time). */
    relaunchDelayMs: number
    /** Delay before retrying a launch that threw. */
    retryDelayMs: number
    /** How many times a throwing launch is retried per step. */
    maxLaunchRetries: number
}

export const defaultPickerChainOptions: PickerChainOptions = {
    relaunchDelayMs: 600,
    retryDelayMs: 1200,
    maxLaunchRetries: 1,
}

type PickFn = () => Promise<ChainPickOutcome>

export type PickerChainHooks = {
    /** Executes one pick (+ implicit auto-send). May throw on launch failure. */
    pick: () => Promise<ChainPickOutcome>
    /** Read at decision time (not captured) — is chaining currently enabled? */
    shouldChain: () => boolean
    /** Optional error sink. */
    onError?: (e: unknown) => void
}

export class PickerChain {
    private busy = false
    private disposed = false
    private timer: ReturnType<typeof setTimeout> | undefined

    constructor(
        private hooks: PickerChainHooks,
        private opts: PickerChainOptions = defaultPickerChainOptions
    ) {}

    /** True while a pick is in flight or a chained step is scheduled. */
    get active(): boolean {
        return this.busy || this.timer !== undefined
    }

    /**
     * Entry point for BOTH the manual attach press and chained steps.
     * Re-entrant calls while busy are ignored (double-tap protection).
     */
    async run(): Promise<void> {
        if (this.busy || this.disposed) return
        this.clearTimer()
        this.busy = true
        try {
            const outcome = await this.pickWithRetry(this.hooks.pick)
            if (outcome === 'sent' && !this.disposed && this.hooks.shouldChain()) {
                this.scheduleNext()
            }
            // canceled / blocked / attached / failed → chain ends silently
        } finally {
            this.busy = false
        }
    }

    /** Cancels any scheduled step and blocks future runs. */
    dispose(): void {
        this.disposed = true
        this.clearTimer()
    }

    /** Cancels a scheduled chained step without blocking manual runs. */
    stop(): void {
        this.clearTimer()
    }

    private async pickWithRetry(pick: PickFn): Promise<ChainPickOutcome | 'failed'> {
        let attempt = 0
        while (true) {
            try {
                return await pick()
            } catch (e) {
                this.hooks.onError?.(e)
                if (attempt >= this.opts.maxLaunchRetries || this.disposed) return 'failed'
                attempt++
                await sleep(this.opts.retryDelayMs)
                if (this.disposed) return 'failed'
            }
        }
    }

    private scheduleNext(): void {
        this.clearTimer()
        this.timer = setTimeout(() => {
            this.timer = undefined
            // Re-check the gate at fire time — settings may have changed while
            // the timer was pending.
            if (this.disposed || !this.hooks.shouldChain()) return
            this.run()
        }, this.opts.relaunchDelayMs)
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer)
            this.timer = undefined
        }
    }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
