import { fetch } from 'expo/fetch'

import { Logger } from '@lib/state/Logger'
type SSEValues = {
    endpoint: string
    method: 'POST' | 'GET'
    body: string
    headers: any
}

export class SSEFetch {
    private abortController: AbortController = new AbortController()
    private decoder = new TextDecoder()
    private onEvent = (data: string) => {}
    private onError = () => {}
    private onClose = () => {}
    private closeStream = () => {}
    private cancelled = false
    /**
     * Carries partial SSE lines across network reads. A read boundary can cut
     * a `data: {...}` line mid-JSON; the old code parsed each chunk in
     * isolation, so both halves failed JSON.parse downstream (the paired
     * "Unexpected end of input" / "Expect ':'" error storms) and the tokens
     * they carried were silently DROPPED from the reply. Only lines terminated
     * by a newline are dispatched; the tail waits for the next read.
     */
    private lineBuffer = ''
    public abort() {
        this.abortController.abort()

        this.closeStream()
        this.closeStream = () => {
            this.cancelled = true
        }
    }

    public async start(values: SSEValues) {
        this.abortController = new AbortController()
        const body = values.method === 'POST' ? { body: values.body } : {}
        this.cancelled = false
        this.lineBuffer = ''
        // Fresh decoder per stream: stream:true decoding keeps internal state
        // for split multi-byte UTF-8 sequences.
        this.decoder = new TextDecoder()
        try {
            const res = await fetch(values.endpoint, {
                signal: this.abortController.signal,
                method: values.method,
                headers: values.headers,
                ...body,
            })
            if (res.status !== 200 || !res.body) {
                Logger.error('Status ' + res.status)
                Logger.error(await res.text())
                return this.onError()
            }
            const reader = res.body.getReader()
            this.closeStream = () => {
                try {
                    reader.cancel()
                    this.cancelled = true
                } catch {}
            }
            while (true) {
                const { value, done } = await reader.read()
                if (done || this.cancelled) break

                // stream:true holds back incomplete multi-byte characters at
                // the chunk edge instead of emitting replacement chars.
                this.lineBuffer += this.decoder.decode(value, { stream: true })

                // Dispatch only COMPLETE lines; keep the unterminated tail.
                const lastNewline = this.lineBuffer.lastIndexOf('\n')
                if (lastNewline === -1) continue
                const complete = this.lineBuffer.slice(0, lastNewline)
                this.lineBuffer = this.lineBuffer.slice(lastNewline + 1)

                const output = parseSSE(complete)
                output.forEach((item) => this.onEvent(item))
            }
            // Flush: final decoder state + any unterminated last line.
            const tail = this.lineBuffer + this.decoder.decode()
            this.lineBuffer = ''
            if (tail.trim() && !this.cancelled) {
                const output = parseSSE(tail)
                output.forEach((item) => this.onEvent(item))
            }
        } catch (e) {
            if (this.abortController.signal.aborted) {
                Logger.debug('Abort caught')
            }
            Logger.error('Request Failed: ' + e)
        } finally {
            this.onClose()
        }
    }

    public setOnEvent(callback: (data: string) => void) {
        this.onEvent = callback
    }

    public setOnError(callback: () => void) {
        this.onError = callback
    }

    public setOnClose(callback: () => void) {
        this.onClose = callback
    }
}

function parseSSE(message: string) {
    const output: string[] = []
    const lines = message.split(/\n/)
    for (const line of lines) {
        // For some APIs like Ollama, they use a ndjson stream
        if (line.startsWith('{')) {
            try {
                JSON.parse(line)
                output.push(line)
                continue
            } catch {
                continue
            }
        }
        const colonIndex = line.indexOf(':')
        if (colonIndex === 0) continue
        const field = colonIndex > 0 ? line.slice(0, colonIndex).trim() : line.trim()
        const value = colonIndex > 0 ? line.slice(colonIndex + 1).trim() : ''
        if (field !== 'data' || value.startsWith('[DONE]')) continue
        output.push(value)
    }

    return output
}
