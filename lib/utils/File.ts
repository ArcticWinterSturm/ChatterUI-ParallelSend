import { localDownload } from '@vali98/react-native-fs'
import { getDocumentAsync } from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'

import { Logger } from '../state/Logger'

export const AppDirectory = {
    ModelPath: `${Paths.document.uri}models/`,
    SessionPath: `${Paths.document.uri}session/`,
    CharacterPath: `${Paths.document.uri}characters/`,
    Assets: `${Paths.document.uri}appAssets/`,
    Attachments: `${Paths.document.uri}attachments/`,
}

export namespace FileUtils {
    export const getDocumentDir = (dir: string) => {
        return `${Paths.document.uri}${dir}`
    }

    export const getCacheDir = (dir: string) => {
        return `${Paths.cache.uri}${dir}`
    }

    /**
     *
     * @param data string data of file
     * @param filename filename to be written, include extension
     * @param encoding encoding of file
     */
    export const saveStringToDownload = async (
        data: string,
        filename: string,
        encoding: 'base64' | `utf8`
    ) => {
        new File(Paths.cache, filename).write(data, { encoding })
        await localDownload((Paths.cache.uri + filename).replace('file://', '')).catch((e) =>
            Logger.error('Failed to download: ' + e)
        )
    }

    export const pickText = async (params: { type?: string } = {}): Promise<PickerResult> => {
        return pickFile(async (file) => {
            return await file.text()
        }, params)
    }

    export const pickBase64 = async (params: { type?: string } = {}): Promise<PickerResult> => {
        return pickFile(async (file) => {
            return await file.base64()
        }, params)
    }

    export const pickJSON = async (params: { type?: string } = {}): Promise<PickerResult> => {
        const result = await pickText(params)
        if (!result.success) return result
        try {
            return { success: true, data: JSON.parse(result.data) }
        } catch {
            return { success: false }
        }
    }

    const pickFile = async (
        fileReader: (file: File) => Promise<string>,
        { type = '*/*' }: { type?: string } = {}
    ): Promise<PickerResult> => {
        const result = await getDocumentAsync({ type: type })
        if (result.canceled) {
            return { success: false }
        }
        const [asset] = result.assets
        const file = new File(asset.uri)
        let data = await fileReader(file)
        if (!data) {
            return { success: false }
        }
        return { success: true, data: data }
    }
}

export const saveStringToDownload = async (
    data: string,
    filename: string,
    encoding: 'base64' | `utf8`
) => {
    new File(Paths.cache, filename).write(data, { encoding })
    await localDownload((Paths.cache.uri + filename).replace('file://', '')).catch((e) =>
        Logger.error('Failed to download: ' + e)
    )
}

type PickerResult = { success: false } | { success: true; data: string }

type JSONPickerResult = { success: false } | { success: true; data: any }

/**@deprecated */
export const pickJSONDocument = async (): Promise<JSONPickerResult> => {
    const result = await pickStringDocument({ type: 'application/json' })
    if (!result.success) return result
    try {
        const jsonData = JSON.parse(result.data)
        return { success: true, data: jsonData }
    } catch {
        return { success: false }
    }
}

/**@deprecated */
export const pickStringDocument = async ({
    encoding = 'utf8',
    type = '*/*',
}: {
    encoding?: 'utf8' | 'base64'
    type?: string
} = {}): Promise<PickerResult> => {
    const result = await getDocumentAsync({ type: type })
    if (result.canceled) {
        return { success: false }
    }
    const uri = result.assets[0].uri
    const file = new File(uri)
    let data = ''
    if (encoding === 'utf8') data = await file.text()
    else data = await file.base64()

    if (!data) {
        return { success: false }
    }
    return { success: true, data: data }
}

const gb = 1000 ** 3
const mb = 1000 ** 2

/**
 * Gets a human friendly version of file size
 * @param size size in bytes
 * @returns string containing readable file size
 */
export const readableFileSize = (size: number) => {
    if (size < gb) {
        const sizeInMB = size / mb
        return `${sizeInMB.toFixed(2)} MB`
    } else {
        const sizeInGB = size / gb
        return `${sizeInGB.toFixed(2)} GB`
    }
}

export const listFiles = (path: string) => {
    return new Directory(path)
        .listAsRecords()
        .filter((item) => !item.isDirectory)
        .map((item) => {
            const uri = item.uri.endsWith('/') ? item.uri.slice(0, -1) : item.uri
            return uri.slice(uri.lastIndexOf('/') + 1)
        })
        .filter((item): item is string => !!item)
}

export const fileExists = (path: string) => {
    return new File(path).exists
}

export const directoryExists = (path: string) => {
    return new Directory(path).exists
}

/**
 * Copies a file and verifies the destination actually exists afterwards.
 *
 * CRITICAL: in expo-file-system SDK 57+, `File.copy()` is a native
 * AsyncFunction (Kotlin suspend on Dispatchers.IO) returning Promise<void>.
 * The old implementation fired it WITHOUT await and returned `true`
 * immediately — the destination did not exist yet when callers read it
 * milliseconds later (FileNotFoundException/ENOENT on hash, thumbnails and
 * asset imports). The await below is what actually blocks until the native
 * write has committed; the existence check converts any silent partial
 * failure into a hard `false` the caller can act on.
 */
export const copyFile = async ({ from, to }: { from: string; to: string }) => {
    try {
        await new File(from).copy(new File(to))
        if (!new File(to).exists) {
            Logger.error(`Copy reported success but destination missing: ${to}`)
            return false
        }
        return true
    } catch (e) {
        Logger.error('Failed to copy: ' + e)
        return false
    }
}

export const deleteFile = (path: string) => {
    try {
        const file = new File(path)
        if (file.exists) file.delete()
        return true
    } catch (e) {
        Logger.error('Failed to delete: ' + e)
        return false
    }
}

export const readBase64Async = async (path: string) => {
    return await new File(path).base64()
}

export const readStringAsync = async (path: string) => {
    return await new File(path).text()
}

export const writeBase64File = async (path: string, content: string) => {
    return await new File(path).write(content, { encoding: 'base64' })
}

export const fileInfo = (path: string) => {
    return new File(path).info()
}

/**
 * Minimal base64 → bytes decoder (pure TS, no Buffer/atob dependency so it is
 * safe on Hermes). Decodes at most `maxBytes` output bytes.
 */
const base64ToBytes = (b64: string, maxBytes: number): Uint8Array => {
    const lookup = new Int16Array(128).fill(-1)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    for (let i = 0; i < alphabet.length; i++) lookup[alphabet.charCodeAt(i)] = i
    const out = new Uint8Array(maxBytes)
    let outLen = 0
    let bits = 0
    let bitCount = 0
    for (let i = 0; i < b64.length && outLen < maxBytes; i++) {
        const c = b64.charCodeAt(i)
        if (c === 61) break // '=' padding
        const v = c < 128 ? lookup[c] : -1
        if (v === -1) continue // skip whitespace/invalid
        bits = (bits << 6) | v
        bitCount += 6
        if (bitCount >= 8) {
            bitCount -= 8
            out[outLen++] = (bits >> bitCount) & 0xff
        }
    }
    return out.subarray(0, outLen)
}

const readUInt32BE = (b: Uint8Array, o: number) =>
    ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

const readUInt16BE = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]

/**
 * Sniff an image/audio mime type from the magic bytes of a base64-encoded
 * file. Last resort of the attachment mime cascade — used when Android
 * provisions neither a usable filename nor a mimeType for a picked file.
 */
export const sniffMimeType = (b64: string): string | null => {
    try {
        if (!b64) return null
        const b = base64ToBytes(b64.slice(0, 32), 16)
        if (b.length < 12) return null
        // PNG
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
        // JPEG
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
        // GIF87a / GIF89a
        if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
        // WEBP: RIFF....WEBP
        if (
            b[0] === 0x52 &&
            b[1] === 0x49 &&
            b[2] === 0x46 &&
            b[3] === 0x46 &&
            b[8] === 0x57 &&
            b[9] === 0x45 &&
            b[10] === 0x42 &&
            b[11] === 0x50
        )
            return 'image/webp'
        // BMP
        if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
        // MP3 (ID3 tag or frame sync)
        if (
            (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
            (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
        )
            return 'audio/mpeg'
        // OGG
        if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg'
        // WAV: RIFF....WAVE
        if (
            b[0] === 0x52 &&
            b[1] === 0x49 &&
            b[2] === 0x46 &&
            b[3] === 0x46 &&
            b[8] === 0x57 &&
            b[9] === 0x41 &&
            b[10] === 0x56 &&
            b[11] === 0x45
        )
            return 'audio/wav'
        // FLAC
        if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'audio/flac'
        // M4A/MP4 audio: ....ftyp
        if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'audio/mp4'
        return null
    } catch {
        return null
    }
}

/**
 * Decode JPEG/PNG/GIF/WEBP(VP8X) dimensions WITHOUT a native image dependency.
 * Parses the base64 already read for the sha256 digest. Returns {width,height}
 * or null when the format is unsupported / unreadable.
 * Used to populate chat_attachment.width/height at attach time (v2).
 */
export const getImageDimensions = (b64: string): { width: number; height: number } | null => {
    try {
        if (!b64) return null
        // Decode up to 192KB — enough to reach the JPEG SOF marker even with
        // large EXIF/ICC segments before it.
        const b = base64ToBytes(b64, 192 * 1024)
        // PNG: 8-byte signature then IHDR width/height (big-endian at 16/20)
        if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) {
            return { width: readUInt32BE(b, 16), height: readUInt32BE(b, 20) }
        }
        // GIF: logical screen descriptor (little-endian at 6/8)
        if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
            return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) }
        }
        // WEBP VP8X: canvas size at offset 24 (24-bit little-endian, minus one)
        if (
            b.length >= 30 &&
            b[0] === 0x52 &&
            b[1] === 0x49 &&
            b[8] === 0x57 &&
            b[9] === 0x45 &&
            b[12] === 0x56 &&
            b[13] === 0x50 &&
            b[14] === 0x38 &&
            b[15] === 0x58
        ) {
            return {
                width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
                height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
            }
        }
        // JPEG: scan for SOF0..SOF15 (excluding 0xC4/0xC8/0xCC)
        if (b.length >= 8 && b[0] === 0xff && b[1] === 0xd8) {
            let i = 2
            while (i + 9 < b.length) {
                if (b[i] !== 0xff) {
                    i++
                    continue
                }
                const marker = b[i + 1]
                if (
                    marker >= 0xc0 &&
                    marker <= 0xcf &&
                    marker !== 0xc4 &&
                    marker !== 0xc8 &&
                    marker !== 0xcc
                ) {
                    return {
                        height: readUInt16BE(b, i + 5),
                        width: readUInt16BE(b, i + 7),
                    }
                }
                const len = readUInt16BE(b, i + 2)
                i += 2 + len
            }
        }
        return null
    } catch {
        return null
    }
}

export const makeDirectory = async (path: string) => {
    new Directory(path).create({ idempotent: true, intermediates: true })
}

/**
 * Guarantees a directory exists RIGHT NOW (synchronous native call) —
 * used by write paths that cannot rely on the startup routine having run
 * (e.g. attachments dir before copying a picked image on a fresh install).
 */
export const ensureDirectoryExists = (path: string): boolean => {
    try {
        const dir = new Directory(path)
        if (!dir.exists) dir.create({ idempotent: true, intermediates: true })
        return dir.exists
    } catch (e) {
        Logger.error(`Failed to ensure directory ${path}: ${e}`)
        return false
    }
}
