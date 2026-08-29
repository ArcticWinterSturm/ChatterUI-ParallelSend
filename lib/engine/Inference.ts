import { t } from 'i18next'

import { ChatSwipe } from '@db/schema'
import { AppSettings } from '@lib/constants/GlobalValues'
import { SamplerID, Samplers as SamplerDefs } from '@lib/constants/SamplerData'
import { isCloseThinkTag, isOpenThinkTag } from '@lib/markdown/ThinkTags'
import { useAppModeStore } from '@lib/state/AppMode'
import { Chats, useInference } from '@lib/state/Chat'
import { Instructs } from '@lib/state/Instructs'
import { SamplersManager } from '@lib/state/SamplerState'
import { useTTSStore } from '@lib/state/TTS'
import { mmkv } from '@lib/storage/MMKV'

import { Characters } from '../state/Characters'
import { Logger } from '../state/Logger'
import { APIBuilderParams, buildAndSendRequest } from './API/APIBuilder'
import { APIConfiguration, APIValues } from './API/APIBuilder.types'
import { APIManager } from './API/APIManagerState'
import { getDataSources } from './DataSources'
import { localInference } from './LocalInference'
import { Tokenizer } from './Tokenizer'

export type GenerationTaskData = {
    swipeId: number
    chatId: number
}

export async function regenerateResponse(swipe: ChatSwipe, regenCache: boolean = true) {
    Logger.info('Regenerate Response' + (regenCache ? '' : ' , Resetting Message'))

    let replacement = ''
    if (regenCache)
        replacement = swipe.reset_length ? swipe.swipe.substring(0, swipe.reset_length) : ''

    Chats.useChatState.getState().setBuffer(swipe.id, { data: replacement })
    await Chats.db.mutate.updateChatSwipe(swipe.id, replacement, {
        updateFinished: true,
        updateStarted: true,
        resetTimings: true,
    })

    await generateResponse(swipe.id)
}

export async function continueResponse(swipe: ChatSwipe) {
    Logger.info(`Continuing Response`)
    await Chats.db.mutate.updateSwipeResetLength(swipe.id, swipe.swipe.length)
    Chats.useChatState.getState().insertToBuffer(swipe.id, swipe.swipe)
    await generateResponse(swipe.id)
}

/**
 * Starts a generation for a swipe. Generations are keyed per-swipe and tagged
 * with their chat, so multiple chats can generate fully in parallel:
 * - remote (API) mode: any number of concurrent streams, one per chat
 * - local mode: the single llama context can only serve one completion, so a
 *   second local request while one is running is rejected
 *
 * The Android keep-alive foreground service is NOT started here — it is
 * refcounted app-wide by startGenerating/stopGenerating (see
 * lib/engine/GenerationService.ts). react-native-background-actions is a
 * singleton: starting it per generation overwrote the previous task's stop
 * resolver and the first stream to finish killed the shared service for all
 * still-streaming generations (field trace: 17 consecutive empty replies).
 * The inference runner executes on the normal JS runtime.
 */
export async function generateResponse(swipeId: number, chatId?: number) {
    const inference = useInference.getState()
    if (inference.isSwipeGenerating(swipeId)) {
        Logger.infoToast(t('generation.errors.generationAlreadyInProgress'))
        return
    }
    const resolvedChatId = chatId ?? (await Chats.db.query.chatIdFromSwipe(swipeId))
    if (!resolvedChatId) {
        Logger.errorToast(t('generation.errors.noActiveChat'))
        return
    }
    if (inference.isChatGenerating(resolvedChatId)) {
        // One generation per chat: a chat's context depends on its own entries.
        Logger.infoToast(t('generation.errors.generationAlreadyInProgress'))
        return
    }
    const appMode = useAppModeStore.getState().appMode
    if (appMode === 'local' && inference.nowGenerating) {
        // A single local llama context cannot serve parallel completions.
        Logger.infoToast(t('generation.errors.generationAlreadyInProgress'))
        return
    }

    useInference.getState().startGenerating(resolvedChatId, swipeId)
    Logger.info(`Obtaining response.`)

    const taskData: GenerationTaskData = { swipeId, chatId: resolvedChatId }
    const runner = appMode === 'local' ? localInference : chatInferenceStream

    // Fire on the JS runtime; every terminal path (stream end, abort, error)
    // funnels through stopGenerating(swipeId), which releases the service ref.
    runner(taskData).catch(async (e) => {
        Logger.error(`Generation task failed: ${Logger.formatError(e)}`)
        await useInference.getState().stopGenerating(swipeId)
    })
}

async function chatInferenceStream(taskData?: GenerationTaskData) {
    if (!taskData) {
        Logger.error('Chat Inference Failed: no task data')
        return
    }
    const { swipeId, chatId } = taskData
    const stop = () => useInference.getState().stopGenerating(swipeId)
    const fields = await obtainFields(chatId)
    if (!fields) {
        Logger.error('Chat Inference Failed')
        await stop()
        return
    }
    fields.stopGenerating = stop
    let reasoningMode: 'structured' | 'raw' | null = null
    fields.onData = (output) => {
        if (!reasoningMode && output.type === 'reasoning') {
            Chats.useChatState.getState().insertToBuffer(swipeId, '<think>')
            reasoningMode = 'raw'
        }

        if (reasoningMode === 'raw' && output.type !== 'reasoning' && reasoningMode === 'raw') {
            Chats.useChatState.getState().insertToBuffer(swipeId, '</think>\n')
            reasoningMode = null
        }

        /**
         * This is a naive implementation that expects output tags to be full tokens
         * Most LLMs are trained so that think_start and think_end tokens are not composite
         */
        if (!reasoningMode && output.type === 'text' && isOpenThinkTag(output.type)) {
            reasoningMode = 'structured'
        }

        if (
            reasoningMode === 'structured' &&
            output.type === 'text' &&
            isCloseThinkTag(output.type)
        ) {
            reasoningMode = null
        }

        Chats.useChatState.getState().insertToBuffer(swipeId, output.content)

        /**
         * considerations
         * - add tool calls
         */
        // Only feed live TTS from the chat the user is currently viewing —
        // parallel background generations should not speak over it.
        if (!reasoningMode && Chats.useChatState.getState().id === chatId)
            useTTSStore.getState().insertBuffer(output.content)
    }

    fields.onEnd = async () => {
        const chatName = await Chats.db.query.chatName(chatId)
        if (!mmkv.getBoolean(AppSettings.AutoGenerateTitle) || chatName !== 'New Chat') return
        Logger.info('Generating Title')
        titleGeneratorStream(chatId)
    }
    const abort = await buildAndSendRequest(fields)
    useInference.getState().setAbort(swipeId, () => {
        Logger.debug('Running Abort')
        abort?.()
    })
}

const titleGeneratorStream = async (chatId: number) => {
    const fields = await obtainFields(chatId)
    if (!fields) {
        Logger.error('Title Generation Failed')
        return
    }
    fields.samplers.genamt = 50
    fields.samplers.reasoning_max_tokens = 0
    fields.samplers.reasoning_effort = 'low'
    fields.samplers.reasoning_exclude = true
    let titleOutput = ''
    fields.onData = (output) => {
        if (output.type === 'text') titleOutput += output.content
    }

    fields.onEnd = () => {
        Logger.debug('Autogenerated Name: ' + titleOutput)
        if (titleOutput)
            Chats.db.mutate.renameChat(
                chatId,
                titleOutput
                    .trim()
                    .replace(/["'.*]/g, '')
                    .replace(/\b\w/g, (char) => char.toUpperCase())
            )
        else Logger.warn('Autogenerated name was blank.')
    }
    const entry = {
        id: -1,
        chat_id: -1,
        name: '',
        is_user: true,
        order: 0,
        swipe_id: 0,
        swipes: [
            {
                id: -1,
                entry_id: -1,
                swipe: 'Generate a short 2-4 word title for this chat. Only Respond with the title and nothing else.',
                send_date: new Date(),
                gen_started: new Date(),
                gen_finished: new Date(),
                timings: null,
                active: true,
                token_length: null,
                reset_length: null,
            },
        ],
        attachments: [],
    }
    fields.messages.push(entry)

    await buildAndSendRequest(fields)
}

// Session-scoped: the stop-sequence truncation warning fired once per
// generation, 100% of the time — warn once and stay quiet.
let warnedStopSequenceLimit = false

const getModelContextLength = (config: APIConfiguration, values: APIValues): number | undefined => {
    const keys = config.model.contextSizeParser.split('.')
    const result = keys.reduce((acc, key) => acc?.[key], values.model)
    return Number.isInteger(result) ? result : undefined
}

// This is the 'big orchestrator' which compiles fields from
// the whole app to send inference requests
async function obtainFields(chatId: number): Promise<APIBuilderParams | void> {
    try {
        const userState = Characters.useUserStore.getState()
        const characterState = Characters.useCharacterStore.getState()
        const apiState = APIManager.useConnectionsStore.getState()
        const instructState = Instructs.useInstruct.getState()

        const userCard = userState.card
        if (!userCard) {
            Logger.errorToast(t('generation.errors.noUser'))
            return
        }

        const characterCard = characterState.card
        if (!characterCard) {
            Logger.errorToast(t('generation.errors.noCharacter'))
            return
        }

        if (!chatId) {
            Logger.errorToast(t('generation.errors.noActiveChat'))
            return
        }

        const messages = (await Chats.db.query.chat(chatId))?.messages
        if (!messages) {
            Logger.errorToast(t('generation.errors.noChatFound'))
            return
        }

        const apiValues = apiState.values.find((item, index) => index === apiState.activeIndex)
        if (!apiValues) {
            Logger.warnToast(t('generation.errors.noActiveAPI'))
            return
        }

        const configs = apiState.getTemplates().filter((item) => item.name === apiValues.configName)

        const apiConfig = configs[0]
        if (!apiConfig) {
            Logger.errorToast(
                t('generation.errors.configurationNotFound', { name: apiValues?.configName })
            )
            return
        }
        const samplers = SamplersManager.getCurrentSampler()
        const modelLengthField = getModelContextLength(apiConfig, apiValues)
        const instructLength = samplers.max_length as number
        const modelLength = modelLengthField ?? (instructLength as number)
        // Generated-length slider pinned to max = uncapped (the field is
        // omitted from the request). Do NOT subtract the sentinel 32k from
        // the prompt budget — that would starve or zero the history window.
        const genamt = samplers.genamt as number
        const genValues = SamplerDefs[SamplerID.GENERATED_LENGTH].values
        const genUncapped =
            (genValues.type === 'integer' || genValues.type === 'float') && genamt >= genValues.max
        const length = apiConfig.model.useModelContextLength
            ? Math.min(modelLength, instructLength)
            : instructLength - (genUncapped ? 0 : genamt)

        let stopSequence = instructState.getStopSequence()
        const stopSequenceLimit = apiConfig.request.stopSequenceLimit
        if (stopSequenceLimit && stopSequence?.length > stopSequenceLimit) {
            stopSequence = stopSequence.slice(0, stopSequenceLimit)
            // Once per session — this fired on 100% of generations and was
            // pure log noise (46 lines in one field trace).
            if (!warnedStopSequenceLimit) {
                warnedStopSequenceLimit = true
                Logger.warn(
                    `Stop sequences truncated to template limit (${stopSequenceLimit}) — further occurrences suppressed`
                )
            }
        }
        const tokenizer = Tokenizer.getTokenizer()

        const dataSources = await getDataSources()

        return {
            apiConfig: Object.assign({}, apiConfig),
            apiValues: Object.assign({}, apiValues),
            onData: () => {},
            onEnd: () => {},
            instruct: instructState.replacedMacros(),
            samplers: Object.assign({}, samplers),
            character: Object.assign({}, characterCard),
            user: Object.assign({}, userCard),
            messages: [...messages],
            stopSequence: stopSequence,
            stopGenerating: () => {},
            chatTokenizer: async (entry, index) => {
                // IMPORTANT - we use -1 for dummy entries
                if (entry.id === -1) return 0
                const [activeSwipe] = entry.swipes.filter((item) => item.active)
                if (!activeSwipe) return 0
                // FIX: the persisted count lives in `token_length` (the actual
                // schema column). The old code read the never-populated
                // `token_count` view-model field AND returned the stale value
                // after recomputing — every message counted as 0 tokens, so the
                // context size never moved (constant 947 in the field trace)
                // and history was never trimmed correctly.
                const cached = activeSwipe.token_length ?? 0
                if (cached > 0) return cached
                if (activeSwipe.swipe.length === 0 && entry.attachments.length === 0) return 0
                const computed = await tokenizer(
                    activeSwipe.swipe,
                    entry.attachments.map((item) => item.uri)
                )
                await Chats.db.mutate.updateSwipeTokenLength(activeSwipe.id, computed)
                return computed
            },
            tokenizer: tokenizer,
            maxLength: length,
            cache: {
                userCache: await characterState.getCache(characterCard.name),
                characterCache: await userState.getCache(userCard.name),
                instructCache: await instructState.getCache(characterCard.name, userCard.name),
            },
            dataSources: dataSources,
        }
    } catch (e) {
        Logger.stackTrace(e)
        Logger.errorToast(
            t('generation.errors.failedToOrchestrateRequestBuild'),
            Logger.formatError(e)
        )
    }
}
