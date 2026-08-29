import BackgroundService from 'react-native-background-actions'

import { Logger } from '@lib/state/Logger'

/**
 * App-level owner of the Android keep-alive foreground service.
 *
 * WHY THIS EXISTS — `react-native-background-actions` is a SINGLETON with a
 * single shared `_stopTask` resolver and a single native service:
 *
 *   _generateTask(task) { return async () => new Promise((resolve) => {
 *       self._stopTask = resolve            // ← overwritten by every start()
 *       task().then(() => self.stop())      // ← first finisher kills the ONE service
 *   })}
 *
 * The previous design called `BackgroundService.start()` once PER GENERATION.
 * With parallel generations (Switch Context on Send fires one every ~5s) each
 * start() clobbered the previous task's resolver, and the first task to finish
 * stopped the shared service for every still-streaming generation. Field
 * forensics: 17 consecutive replies with `swipe=''`/`token_length=NULL`,
 * 12 "Obtaining response" with 0 "Stream Closed".
 *
 * NEW MODEL — the service is REFCOUNTED and started at most once:
 * - `acquire()` on generation start: first acquirer starts the service with a
 *   keeper task that stays pending until release.
 * - `release()` on generation end (all terminal paths run through
 *   `useInference.stopGenerating`): last releaser stops the service.
 * - All start/stop transitions are serialized through a promise chain so a
 *   stop can never overtake a start (or vice versa) on the native side.
 *
 * Inference itself no longer runs inside the background task — the task's only
 * job is keeping the process alive; the streams run on the normal JS runtime.
 */

const serviceOptions = {
    taskName: 'chatterui_completion_task',
    taskTitle: 'Running completion...',
    taskDesc: 'ChatterUI is running a completion task',
    taskIcon: {
        name: 'ic_launcher',
        type: 'mipmap',
    },
    color: '#403737',
    linkingURI: 'chatterui://',
    progressBar: {
        max: 1,
        value: 0,
        indeterminate: true,
    },
}

let refs = 0
// Serializes native start/stop transitions.
let transition: Promise<void> = Promise.resolve()

// Never resolves on its own: `BackgroundService.stop()` resolves the library's
// outer wrapper (its `_stopTask`), which is the sanctioned teardown path. The
// inner pending promise holds no timers/refs and is GC-safe.
const keeperTask = async () => {
    await new Promise<void>(() => {})
}

export const acquireGenerationService = () => {
    refs++
    if (refs !== 1) return
    transition = transition.then(async () => {
        // A release may have zeroed the count while we waited for a prior
        // transition — do not start a service nobody needs.
        if (refs === 0) return
        try {
            await BackgroundService.start(keeperTask, serviceOptions)
        } catch (e) {
            // Keep-alive is best-effort: a failed service start must never
            // block the generation itself.
            Logger.warn(`[GenerationService] failed to start service: ${Logger.formatError(e)}`)
        }
    })
}

export const releaseGenerationService = () => {
    refs = Math.max(0, refs - 1)
    if (refs !== 0) return
    transition = transition.then(async () => {
        // Re-acquired while waiting — keep the service alive.
        if (refs > 0) return
        try {
            // stop() resolves the pending keeper via the library's _stopTask
            // and tears down the native service exactly once.
            await BackgroundService.stop()
        } catch (e) {
            Logger.warn(`[GenerationService] failed to stop service: ${Logger.formatError(e)}`)
        }
    })
}
