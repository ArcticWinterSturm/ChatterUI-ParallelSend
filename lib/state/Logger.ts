import Toast from 'react-native-simple-toast'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { Storage } from '@lib/enums/Storage'

import { AppSettings } from '../constants/GlobalValues'
import { createMMKVStorage, mmkv } from '../storage/MMKV'

const toastTime = Toast.SHORT
const maxloglength = 2000

export enum LogLevel {
    INFO,
    WARN,
    ERROR,
    DEBUG,
}

type LogEntry = {
    timestamp: string
    message: string
    level: LogLevel
}

type LogStateProps = {
    logs: LogEntry[]
    addLog: (entry: LogEntry) => void
    flushLogs: () => void
}

export namespace Logger {
    export const useLoggerStore = create<LogStateProps>()(
        persist(
            (set, get) => ({
                logs: [],
                addLog: (entry) => {
                    const newlogs = [...get().logs, entry]
                    if (newlogs.length > maxloglength) newlogs.shift()
                    set({ logs: newlogs })
                },
                flushLogs: () => {
                    set({ logs: [] })
                },
            }),
            {
                name: Storage.Logs,
                storage: createMMKVStorage(),
                version: 1,
                partialize: (state) => ({
                    logs: state.logs,
                }),
                migrate: async (persistedState: any, version) => {
                    //no migrations yet
                },
            }
        )
    )

    export const LevelName: Record<LogLevel, string> = {
        [LogLevel.INFO]: '[INFO]',
        [LogLevel.WARN]: '[WARN]',
        [LogLevel.ERROR]: '[ERROR]',
        [LogLevel.DEBUG]: '[DEBUG]',
    }

    const insertLogs = (data: LogEntry) => {
        useLoggerStore.getState().addLog(data)
    }

    const createLog = (data: string, level: LogLevel): LogEntry => {
        const timestamp = `[${new Date().toTimeString().substring(0, 8)}]`
        return { timestamp: timestamp, message: data, level: level }
    }

    const printLog = (log: LogEntry) => {
        console.log(`${LevelName[log.level]}${log.timestamp}: ${log.message}`)
    }

    export const info = (data: string) => {
        const logItem = createLog(data, LogLevel.INFO)
        printLog(logItem)
        insertLogs(logItem)
    }

    export const infoToast = (data: string, internal?: string) => {
        info(data)
        if (internal) {
            info(internal)
        }
        Toast.show(data, toastTime)
    }

    export const warn = (data: string) => {
        const logItem = createLog(data, LogLevel.WARN)
        printLog(logItem)
        insertLogs(logItem)
    }

    export const warnToast = (data: string, internal?: string) => {
        warn(data)
        if (internal) {
            warn(internal)
        }
        Toast.show(data, toastTime, { textColor: 'yellow' })
    }

    export const error = (data: string) => {
        const logItem = createLog(data, LogLevel.ERROR)
        printLog(logItem)
        insertLogs(logItem)
    }

    export const errorToast = (data: string, internal?: string) => {
        error(data)
        if (internal) {
            error(internal)
        }
        Toast.show(data, toastTime, { textColor: 'red' })
    }

    export const debug = (data: string) => {
        if (!__DEV__ && !mmkv.getBoolean(AppSettings.DevMode)) return
        const logItem = createLog(data, LogLevel.DEBUG)
        printLog(logItem)
        insertLogs(logItem)
    }

    export const debugToast = (data: string, internal?: string) => {
        error(data)
        if (internal) {
            error(internal)
        }
        Toast.show(data, toastTime, {
            textColor: 'blue',
        })
    }

    export const errorFn = (e: unknown) => {
        if (e instanceof Error) {
            const firstLine = e.stack
                ?.split('\n')?.[1]
                ?.trim()
                ?.replace(/\s*\(.*\)/, '')
            if (firstLine) {
                error('Error occured:' + firstLine)
            }
        }
    }
    export const stackTrace = (e: unknown) => {
        if (e instanceof Error && e.stack) {
            error(e.stack)
        }
    }

    /**
     * Serializes any thrown value into a diagnosable string.
     *
     * `JSON.stringify(err)` yields `"{}"` for Error instances because
     * `message`/`stack` are non-enumerable — a field trace showed 75% of a
     * session log reduced to literal `{}` lines, destroying all diagnostics.
     * Always log caught values through this helper.
     */
    export const formatError = (e: unknown): string => {
        if (e instanceof Error) {
            const parts = [`${e.name}: ${e.message}`]
            const stackLines = e.stack?.split('\n')?.slice(1, 6)?.join('\n')?.trim()
            if (stackLines) parts.push(stackLines)
            const cause = (e as { cause?: unknown }).cause
            if (cause !== undefined) parts.push(`cause: ${String(cause)}`)
            return parts.join('\n')
        }
        if (typeof e === 'string') return e
        try {
            const json = JSON.stringify(e)
            return json === '{}' || json === undefined ? String(e) : json
        } catch {
            return String(e)
        }
    }
}
