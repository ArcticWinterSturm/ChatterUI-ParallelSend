import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'

import { Storage } from '@lib/enums/Storage'
import { CharacterLink } from '@lib/state/CharacterLinks'
import { Logger } from '@lib/state/Logger'
import { createMMKVStorage } from '@lib/storage/MMKV'

import { APIConfiguration, APIValues } from './APIBuilder.types'
import { defaultTemplates } from './DefaultAPI'

export interface APIManagerValue extends APIValues {
    active: boolean
    friendlyName: string
}

type APIManagerPreferences = {
    showCustomFields: boolean
}

type APIStateProps = {
    activeIndex: number
    values: APIManagerValue[]
    preferences: APIManagerPreferences
    updatePreferences: (preferences: Partial<APIManagerPreferences>) => void
    customTemplates: APIConfiguration[]
    addValue: (template: APIManagerValue) => void
    addTemplate: (values: APIConfiguration) => void
    removeValue: (index: number) => void
    setActiveIndex: (index: number) => void
    removeTemplate: (index: number) => void
    editValue: (value: APIManagerValue, index: number) => void
    getTemplates: () => APIConfiguration[]
}

export namespace APIManager {
    export const useConnectionsStore = create<APIStateProps>()(
        persist(
            (set, get) => ({
                activeIndex: -1,
                preferences: { showCustomFields: false },
                values: [],
                customTemplates: [],
                updatePreferences: (preferences) =>
                    set({ preferences: { ...get().preferences, ...preferences } }),
                addValue: (value) => {
                    const values = [...get().values]
                    values.forEach((item) => (item.active = false))
                    values.push(value)
                    set({
                        values: values,
                        activeIndex: values.length - 1,
                    })
                },
                setActiveIndex: (activeIndex) => {
                    const values = get().values.map((item) => ({ ...item, active: false }))
                    if (activeIndex > values.length) return
                    values[activeIndex].active = true
                    set({ activeIndex, values })
                },
                addTemplate: (template) => {
                    const templates = get().getTemplates()
                    if (templates.some((item) => item.name === template.name)) {
                        const newName = generateUniqueName(
                            template.name,
                            templates.map((item) => item.name)
                        )
                        Logger.info(`Name exists, renaming to: ${newName}`)
                        template.name = newName
                    }
                    const output = verifyJSON(template, defaultTemplates[0])
                    set((state) => ({
                        customTemplates: [...state.customTemplates, output],
                    }))
                },
                removeValue: (index) => {
                    const values = [...get().values]
                    let activeIndex = get().activeIndex
                    if (index === activeIndex) {
                        activeIndex = -1
                    }
                    values.splice(index, 1)
                    CharacterLink.db.mutate.deleteByValue('connection_index', index)
                    set({ values: values, activeIndex: activeIndex })
                },
                removeTemplate: (index) => {
                    const templates = get().customTemplates
                    templates.splice(index, 1)
                    set((state) => ({ customTemplates: [...templates] }))
                },
                editValue: (newValue, index) => {
                    const values = [...get().values]
                    const oldValue = values[index]
                    values[index] = newValue
                    let active = {}
                    if (newValue.active && !oldValue.active) {
                        values.forEach((item, newindex) => {
                            item.active = newindex === index
                        })
                        active = { activeIndex: index }
                    }
                    if (!newValue.active && oldValue.active) {
                        active = { activeIndex: -1 }
                    }
                    set({ values: values, ...active })
                },
                getTemplates: () => {
                    return [...defaultTemplates, ...get().customTemplates]
                },
            }),
            {
                name: Storage.API,
                storage: createMMKVStorage(),
                version: 3,
                migrate: (persistedState: any, version) => {
                    if (version === 1) {
                        persistedState.preferences = { showCustomFields: false }
                    }
                    if (version === 2) {
                        // Heal templates imported before the verifyJSON fix:
                        // they inherited the OpenAI reference's ENTIRE
                        // ui.display block (name, icon, priority 10100) and
                        // rendered as a second "OpenAI" instead of their own
                        // name (e.g. Agnes). Drop the borrowed block — the UI
                        // falls back to the template's root name.
                        persistedState.customTemplates = (persistedState.customTemplates ?? []).map(
                            (tpl: any) => {
                                if (
                                    tpl?.ui?.display?.name &&
                                    tpl.name &&
                                    tpl.ui.display.name !== tpl.name
                                ) {
                                    const { display, ...ui } = tpl.ui
                                    return { ...tpl, ui }
                                }
                                return tpl
                            }
                        )
                    }
                    return persistedState
                },
            }
        )
    )

    export function useActiveValueTemplate() {
        const { activeIndex, values, getTemplates } = useConnectionsStore(
            useShallow((store) => ({
                activeIndex: store.activeIndex,
                values: store.values,
                getTemplates: store.getTemplates,
            }))
        )

        const apiValue: APIManagerValue | undefined = values[activeIndex]
        const apiConfig = getTemplates().find((item) => item.name === apiValue?.configName)

        return { apiValue, apiConfig }
    }
}

// recursively fill json in case it is incorrect
const verifyJSON = (source: any, target: any): any => {
    const fillFields = (sourceObj: any, targetObj: any): any => {
        if (typeof sourceObj !== 'object' || sourceObj === null) {
            sourceObj = Array.isArray(targetObj) ? [] : {}
        }
        for (const key of Object.keys(targetObj)) {
            if (key === 'samplerFields') continue
            // NEVER inherit the reference template's display identity —
            // filling `ui.display` from the OpenAI default made every custom
            // template without its own display block render as a second
            // "OpenAI" (name, icon AND sort priority were copied).
            if (key === 'display') continue
            if (!(key in sourceObj)) {
                sourceObj[key] = targetObj[key]
            } else if (typeof targetObj[key] === 'object' && targetObj[key] !== null) {
                sourceObj[key] = fillFields(sourceObj[key], targetObj[key])
            }
        }
        return sourceObj
    }
    const result = fillFields(source, target)
    // A display block that exists but carries no name would still fall back
    // to config.name in the UI — but if it carries a name COPIED from a
    // reference (pre-fix imports), prefer the template's own name when they
    // conflict with the root name and the root name is unique.
    if (result?.ui?.display && !source?.ui?.display?.name) {
        result.ui.display.name = result.name
    }
    return result
}

function generateUniqueName(baseName: string, names: string[]) {
    const regex = new RegExp(`^${baseName}\\s\\((\\d+)\\)$`)
    const existingNumbers = names
        .map((item) => {
            const match = item.match(regex)
            return match ? parseInt(match[1], 10) : null
        })
        .filter((num) => num !== null)
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1
    return `${baseName} (${nextNumber})`
}
