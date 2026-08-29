import { t } from 'i18next'

import { SamplerConfigData } from '@lib/constants/SamplerData'

import { CharacterLink } from './CharacterLinks'
import { Instructs, InstructType } from './Instructs'
import { Logger } from './Logger'
import { fixSamplerConfig, SamplerConfig, SamplersManager } from './SamplerState'

/**
 * Embedded presets: a Character Card V2 `data.extensions.chatterui` payload
 * carrying the Instruct (formatting template) and Sampler configuration the
 * card was authored with.
 *
 * - PACK   on export: the card ships with its template AND sampler built in.
 * - UNPACK on import: the presets are registered (instruct row / sampler
 *   config) and linked to the character via character links
 *   (`instruct_id` / `sampler_index`), so opening the character automatically
 *   applies them through the existing link-loading path.
 *
 * The `extensions` field is part of the CCv2 spec and ignored by other
 * frontends, so cards remain fully portable.
 */

export const CARD_EXTENSION_KEY = 'chatterui'

export type EmbeddedPresets = {
    preset_version: 1
    instruct?: Omit<InstructType, 'id'>
    sampler?: SamplerConfig
}

type CharacterLinkLite = {
    type: string
    value: number
}

/**
 * Collects the presets to embed on export.
 * Prefers the character's explicit links; falls back to the currently active
 * instruct/sampler so every exported card is self-contained.
 */
export const packEmbeddedPresets = async (
    links: CharacterLinkLite[] | undefined
): Promise<EmbeddedPresets | undefined> => {
    try {
        let instruct: InstructType | undefined
        const instructLink = links?.find((item) => item.type === 'instruct_id')
        if (instructLink) instruct = await Instructs.db.query.instruct(instructLink.value)
        if (!instruct) instruct = Instructs.useInstruct.getState().data

        let sampler: SamplerConfig | undefined
        const samplerLink = links?.find((item) => item.type === 'sampler_index')
        const configList = SamplersManager.useSamplerStore.getState().configList
        if (samplerLink !== undefined) sampler = configList[samplerLink.value]
        if (!sampler)
            sampler = configList[SamplersManager.useSamplerStore.getState().currentConfigIndex]

        if (!instruct && !sampler) return undefined

        const result: EmbeddedPresets = { preset_version: 1 }
        if (instruct) {
            const { id, ...rest } = instruct
            result.instruct = rest
        }
        if (sampler) {
            result.sampler = {
                name: sampler.name,
                data: { ...sampler.data },
            }
        }
        return result
    } catch (e) {
        Logger.warn(`[CardEmbeddedPresets] pack failed: ${e}`)
        return undefined
    }
}

/**
 * Registers embedded presets from an imported card and links them to the
 * character. Reuses existing entries by name to keep repeated imports
 * idempotent (no duplicate template/sampler spam).
 */
export const unpackEmbeddedPresets = async (charId: number, extensions: any) => {
    const embedded = extensions?.[CARD_EXTENSION_KEY] as EmbeddedPresets | undefined
    if (!embedded || typeof embedded !== 'object') return
    try {
        if (embedded.instruct && typeof embedded.instruct === 'object') {
            const instructId = await registerInstruct(embedded.instruct)
            if (instructId !== undefined) {
                await CharacterLink.db.mutate.upsert(charId, 'instruct_id', instructId)
                Logger.infoToast(
                    t('character.editor.embedded.unpackedInstruct', {
                        name: embedded.instruct.name ?? '',
                        defaultValue: 'Loaded embedded Instruct template: {{name}}',
                    })
                )
            }
        }
        if (embedded.sampler && typeof embedded.sampler === 'object') {
            const samplerIndex = registerSampler(embedded.sampler)
            if (samplerIndex !== undefined) {
                await CharacterLink.db.mutate.upsert(charId, 'sampler_index', samplerIndex)
                Logger.infoToast(
                    t('character.editor.embedded.unpackedSampler', {
                        name: embedded.sampler.name ?? '',
                        defaultValue: 'Loaded embedded Sampler config: {{name}}',
                    })
                )
            }
        }
    } catch (e) {
        Logger.warnToast(
            t('character.editor.embedded.unpackFailed', {
                defaultValue: 'Failed to unpack embedded presets',
            })
        )
        Logger.warn(`[CardEmbeddedPresets] unpack failed: ${e}`)
    }
}

/** Creates (or reuses by name) an instruct row from an embedded template. */
const registerInstruct = async (data: Omit<InstructType, 'id'>): Promise<number | undefined> => {
    if (!data.name || typeof data.name !== 'string') return undefined

    // Reuse an existing template with the same name — repeat imports must not
    // create duplicates.
    const existing = (await Instructs.db.query.instructList())?.find(
        (item) => item.name === data.name
    )
    if (existing) return existing.id

    // Merge over the default instruct so cards from older/newer versions with
    // missing fields still produce a complete, valid row.
    const { id: _, ...defaults } = Instructs.defaultInstruct
    const merged: InstructType = { ...defaults, ...sanitize(data, defaults) }
    return await Instructs.db.mutate.createInstruct(merged)
}

/** Adds (or reuses by name) a sampler config; returns its index in the list. */
const registerSampler = (sampler: SamplerConfig): number | undefined => {
    if (!sampler.name || typeof sampler.name !== 'string') return undefined
    if (!sampler.data || typeof sampler.data !== 'object') return undefined

    const store = SamplersManager.useSamplerStore.getState()
    const existingIndex = store.configList.findIndex((item) => item.name === sampler.name)
    if (existingIndex !== -1) return existingIndex

    const fixed: SamplerConfig = {
        name: sampler.name,
        data: fixSamplerConfig({ ...(sampler.data as SamplerConfigData) }),
    }
    // Append WITHOUT switching the active config — importing a card should not
    // change the current session's sampler until the character is opened.
    SamplersManager.useSamplerStore.setState((state) => ({
        configList: [...state.configList, fixed],
    }))
    return SamplersManager.useSamplerStore.getState().configList.length - 1
}

/** Keeps only keys known to the default template, with matching primitive types. */
const sanitize = <T extends object>(data: any, reference: T): Partial<T> => {
    const out: any = {}
    for (const key of Object.keys(reference)) {
        if (!(key in data)) continue
        const refType = typeof (reference as any)[key]
        if (typeof data[key] === refType) out[key] = data[key]
    }
    return out
}
