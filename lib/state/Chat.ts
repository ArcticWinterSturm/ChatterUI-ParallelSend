import { and, count, desc, eq, getTableColumns, like, not, sql, sum } from 'drizzle-orm'
import * as Crypto from 'expo-crypto'
import { randomUUID } from 'expo-crypto'
import * as Notifications from 'expo-notifications'
import { t } from 'i18next'
import mime from 'mime/lite'
import { AppState } from 'react-native'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { db as database } from '@db/db'
import {
    chatAttachments,
    ChatAttachmentType,
    chatEntries,
    ChatEntryType,
    chats,
    ChatSwipe,
    chatSwipes,
    ChatType,
    CompletionTimings,
} from '@db/schema'
import { acquireGenerationService, releaseGenerationService } from '@lib/engine/GenerationService'
import { Tokenizer } from '@lib/engine/Tokenizer'
import { replaceMacros } from '@lib/state/Macros'
import {
    AppDirectory,
    copyFile,
    deleteFile,
    ensureDirectoryExists,
    fileInfo,
    getImageDimensions,
    readBase64Async,
    sniffMimeType,
} from '@lib/utils/File'
import { convertToFormatInstruct } from '@lib/utils/TextFormat'

import { Characters } from './Characters'
import { Logger } from './Logger'
import { AppSettings } from '../constants/GlobalValues'
import { mmkv } from '../storage/MMKV'

export interface ChatSwipeState extends ChatSwipe {
    token_count?: number
    attachment_count?: number
    regen_cache?: string
}

export interface ChatEntry extends ChatEntryType {
    swipes: ChatSwipeState[]
    attachments: ChatAttachmentType[]
}

export interface ChatData extends ChatType {
    messages: ChatEntry[]
    autoScroll?: { cause: 'search' | 'saveScroll'; index: number }
}

/**
 * Payload for createEntry attachments — a flat object instead of string[].
 * `name` / `mimeType` / dimensions come from the picker asset when Android
 * provisions them; every field besides `uri` is optional and reconstructed
 * through a cascade in createAttachment when missing.
 */
export type AttachmentPayload = {
    uri: string
    name?: string | null
    mimeType?: string | null
    size?: number
    width?: number
    height?: number
}

interface ChatSearchQueryResult {
    swipeId: number
    chatId: number
    chatEntryId: number
    chatName: string
    swipe: string
    sendDate: number
}

interface ChatSearchResult extends Omit<ChatSearchQueryResult, 'sendDate'> {
    sendDate: Date
}

export type ScrollData = { cause: 'search' | 'saveScroll'; index: number }

type UpdateChatSwipeOptions = {
    updateFinished?: boolean
    updateStarted?: boolean
    timings?: CompletionTimings
    resetTimings?: boolean
}

export interface ChatState {
    id?: number
    scrollData?: ScrollData
    // Per-generation output buffers, keyed by swipeId. Multiple chats can
    // generate concurrently; each stream appends to its own buffer so chat
    // switching can never mix or corrupt streamed text.
    buffers: Record<number, OutputBuffer>
    // chat data
    setId: (chatId: number) => Promise<void>
    reset: () => void
    setBuffer: (swipeId: number, data: OutputBuffer) => void
    setBufferTimings: (swipeId: number, timings: CompletionTimings) => void
    insertToBuffer: (swipeId: number, data: string) => void
    updateFromBuffer: (swipeId: number) => Promise<void>
    flushBufferToDb: () => Promise<void>
}

export type ActiveGeneration = {
    chatId: number
    swipeId: number
}

type InferenceStateType = {
    // Multiple generations may run at once: one per swipe, across chats.
    nowGenerating: boolean
    active: Record<number, ActiveGeneration>
    abortFunction: Record<number, () => void | Promise<void>>
    startGenerating: (chatId: number, swipeId: number) => void
    stopGenerating: (swipeId: number) => Promise<void>
    setAbort: (swipeId: number, fn: () => void | Promise<void>) => void
    abortChat: (chatId: number | undefined) => Promise<void>
    isChatGenerating: (chatId: number | undefined) => boolean
    isSwipeGenerating: (swipeId: number) => boolean
}

type OutputBuffer = {
    data: string
    timings?: CompletionTimings
    error?: string
}

type ChatSwipeUpdated = Pick<ChatSwipe, 'swipe' | 'id'> & Partial<Omit<ChatSwipe, 'swipe' | 'id'>>
// TODO: Functionalize and move elsewhere
export const sendGenerateCompleteNotification = async (chatId: number, text?: string) => {
    const showMessage = mmkv.getBoolean(AppSettings.ShowNotificationText)

    const notificationTitle = showMessage
        ? (Characters.useCharacterStore.getState().card?.name ?? '')
        : 'Response Complete'

    const notificationText = showMessage
        ? (text ?? '').trim()
        : 'ChatterUI has finished a response.'

    Notifications.scheduleNotificationAsync({
        content: {
            title: notificationTitle,
            body: notificationText,
            sound: mmkv.getBoolean(AppSettings.PlayNotificationSound),
            vibrate: mmkv.getBoolean(AppSettings.VibrateNotification) ? [250, 125, 250] : undefined,
            badge: 0,
            data: {
                chatId: chatId,
                characterId: Characters.useCharacterStore.getState().id,
            },
        },
        trigger: null,
    })
    Notifications.setBadgeCountAsync(0)
}

const setMismatchedUser = async (userId: number) => {
    if (!userId || !mmkv.getBoolean(AppSettings.AutoLoadUser)) return

    const currentUserId = Characters.useUserStore.getState().id
    if (currentUserId === userId) return

    Logger.info('Autoloading User with ID: ' + userId)
    const name = await Characters.useUserStore.getState().setCard(userId)

    if (name) Logger.infoToast(t('users.messages.loadingUser', { name }))
    else
        Logger.warn(
            `Failed to load User with ID ${userId}, it was likely deleted. Consider relinking this chat.`
        )
}

// Guards stopGenerating against re-entrant double-commit (abort + close race).
const stoppingSwipes = new Set<number>()

export const useInference = create<InferenceStateType>((set, get) => ({
    abortFunction: {},
    nowGenerating: false,
    active: {},
    startGenerating: (chatId: number, swipeId: number) => {
        set((s) => ({
            active: { ...s.active, [swipeId]: { chatId, swipeId } },
            nowGenerating: true,
        }))
        // Refcounted keep-alive: the foreground service starts with the first
        // generation and stops with the last — never per-generation (the
        // library is a singleton; per-generation start/stop killed parallel
        // streams; see lib/engine/GenerationService.ts).
        acquireGenerationService()
    },
    stopGenerating: async (swipeId: number) => {
        const gen = get().active[swipeId]
        // Idempotent per generation: user-abort AND stream-close can both fire.
        if (!gen) return
        // Reserve immediately so re-entrant calls (abort + stream-close racing)
        // cannot double-commit or double-release the service ref.
        set((s) => {
            const abortFunction = { ...s.abortFunction }
            delete abortFunction[swipeId]
            return { abortFunction }
        })
        if (stoppingSwipes.has(swipeId)) return
        stoppingSwipes.add(swipeId)
        const text = Chats.useChatState.getState().buffers[swipeId]?.data
        try {
            // Commit BEFORE removing from the registry so subscribers (TTS end
            // handler, queued sends) observe 'ended' only after the text is in
            // SQLite.
            Logger.info(`Saving Chat`)
            await Chats.useChatState.getState().updateFromBuffer(swipeId)
            Chats.useChatState.getState().setBuffer(swipeId, { data: '' })
        } finally {
            // Even if the DB write throws, the generation must leave the
            // registry and release its keep-alive service ref — a stuck
            // 'active' entry would block sends and pin the service forever.
            set((s) => {
                const active = { ...s.active }
                delete active[swipeId]
                return { active, nowGenerating: Object.keys(active).length > 0 }
            })
            stoppingSwipes.delete(swipeId)
            releaseGenerationService()
        }
        if (mmkv.getBoolean(AppSettings.NotifyOnComplete))
            sendGenerateCompleteNotification(gen.chatId, text)
    },
    setAbort: (swipeId: number, fn: () => void | Promise<void>) =>
        set((s) => ({ abortFunction: { ...s.abortFunction, [swipeId]: fn } })),
    abortChat: async (chatId: number | undefined) => {
        if (chatId === undefined) return
        const entries = Object.entries(get().active).filter(([, g]) => g.chatId === chatId)
        for (const [key] of entries) {
            const swipeId = Number(key)
            const fn = get().abortFunction[swipeId]
            if (fn) await fn()
            // The abort function is expected to trigger stopGenerating via its
            // stream teardown; run it anyway (idempotent) in case it did not.
            await get().stopGenerating(swipeId)
        }
    },
    isChatGenerating: (chatId: number | undefined) =>
        chatId !== undefined && Object.values(get().active).some((g) => g.chatId === chatId),
    isSwipeGenerating: (swipeId: number) => !!get().active[swipeId],
}))

// Periodic stream checkpoint bookkeeping (per swipe, module-local).
const STREAM_CHECKPOINT_MS = 2000
const streamCheckpointAt: Record<number, number> = {}

export namespace Chats {
    export const useChatState = create<ChatState>((set, get: () => ChatState) => ({
        buffers: {},
        setId: async (chatId) => {
            // If any generation is streaming and the user switches chats, persist the
            // text so far FIRST (per-swipe). This is what makes chat switching atomic:
            // replies keep streaming into their own buffers and are committed again at
            // stream end, but a kill mid-switch can no longer lose anything.
            if (useInference.getState().nowGenerating) await get().flushBufferToDb()
            const data = { ...(await db.query.chatNew(chatId)), autoScroll: undefined }
            let autoScroll: { cause: 'search' | 'saveScroll'; index: number } | undefined =
                undefined
            if (!data) {
                Logger.errorToast(
                    t('chat.state.failedToLoad', { id: chatId }),
                    JSON.stringify(data)
                )
                return
            }
            if (data.user_id) await setMismatchedUser(data.user_id)
            if (data) {
                const index = data.scroll_offset ?? data.entriesCount
                autoScroll = {
                    cause: 'saveScroll',
                    index: Math.min(index, data.entriesCount - 1),
                }
            }

            set({
                id: chatId,
                scrollData: autoScroll,
            })
        },

        reset: () => set({ id: undefined }),

        setBuffer: (swipeId: number, newBuffer: OutputBuffer) =>
            set((s) => ({ buffers: { ...s.buffers, [swipeId]: newBuffer } })),
        setBufferTimings: (swipeId: number, timings: CompletionTimings) =>
            set((s) => ({
                buffers: {
                    ...s.buffers,
                    [swipeId]: { ...(s.buffers[swipeId] ?? { data: '' }), timings },
                },
            })),
        insertToBuffer: (swipeId: number, data: string) => {
            set((s) => ({
                buffers: {
                    ...s.buffers,
                    [swipeId]: {
                        ...(s.buffers[swipeId] ?? { data: '' }),
                        data: (s.buffers[swipeId]?.data ?? '') + data,
                    },
                },
            }))
            // Defence in depth against abnormal termination (process kill,
            // service teardown, crash): checkpoint the stream to SQLite at most
            // once per interval so a dead stream loses only the last increment
            // instead of the entire reply. Terminal-path commits still run the
            // full updateFromBuffer with token counts.
            const now = Date.now()
            const last = streamCheckpointAt[swipeId] ?? 0
            if (now - last >= STREAM_CHECKPOINT_MS) {
                streamCheckpointAt[swipeId] = now
                const text = get().buffers[swipeId]?.data
                if (text)
                    db.mutate
                        .checkpointSwipeText(swipeId, text)
                        .catch((e) => Logger.warn(`[checkpoint] failed: ${Logger.formatError(e)}`))
            }
        },

        updateFromBuffer: async (swipeId) => {
            const buffer = get().buffers[swipeId]
            if (!buffer?.data && !buffer?.timings) return
            await db.mutate.updateChatSwipe(swipeId, buffer.data, {
                timings: buffer.timings,
            })
        },

        flushBufferToDb: async () => {
            // Writes every in-flight stream's text to its swipe row without clearing
            // buffers and without stopping the streams. Idempotent by nature
            // (same swipeId + growing text) so it is safe to call on every switch.
            const active = useInference.getState().active
            for (const swipeId of Object.keys(active).map(Number)) {
                const buffer = get().buffers[swipeId]
                if (buffer?.data)
                    await db.mutate.updateChatSwipe(swipeId, buffer.data, {
                        timings: buffer.timings,
                    })
            }
        },
    }))

    export namespace db {
        export namespace query {
            export const chat = async (chatId: number) => {
                const chat = await database.query.chats.findFirst({
                    where: eq(chats.id, chatId),
                    with: {
                        messages: {
                            with: {
                                swipes: {
                                    where: eq(chatSwipes.active, true),
                                    limit: 1,
                                },
                                attachments: true,
                            },
                        },
                    },
                })
                if (chat) return { ...chat }
            }

            export const chatShallow = async (chatId: number) => {
                const chat = await database.query.chats.findFirst({
                    where: eq(chats.id, chatId),
                })
                return chat
            }

            export const chatNew = async (chatId: number) => {
                const [result] = await database
                    .select({
                        user_id: chats.user_id,
                        scroll_offset: chats.scroll_offset,
                        entriesCount: count(chatEntries.id),
                    })
                    .from(chats)
                    .leftJoin(chatEntries, eq(chatEntries.chat_id, chats.id))
                    .where(eq(chats.id, chatId))
                    .groupBy(chats.id)

                return result
            }

            /** Resolves the chat a swipe belongs to — used to key generations by chat. */
            export const chatIdFromSwipe = async (swipeId: number): Promise<number | undefined> => {
                const swipe = await database.query.chatSwipes.findFirst({
                    where: eq(chatSwipes.id, swipeId),
                    columns: { entry_id: true },
                })
                if (!swipe) return
                const entry = await database.query.chatEntries.findFirst({
                    where: eq(chatEntries.id, swipe.entry_id),
                    columns: { chat_id: true },
                })
                return entry?.chat_id
            }

            /**
             * Newest chat of a character that contains no user messages (at
             * most the greeting entry). Used by Switch-Context-on-Send to
             * REUSE an already-empty conversation as the landing context
             * instead of stacking new ones — a field trace showed 45% of all
             * chats were empty artifacts of unconditional creation.
             */
            export const latestEmptyChatId = async (
                charId: number
            ): Promise<number | undefined> => {
                const candidates = await database.query.chats.findMany({
                    where: eq(chats.character_id, charId),
                    orderBy: desc(chats.last_modified),
                    columns: { id: true },
                    with: {
                        messages: {
                            columns: { id: true, is_user: true },
                            limit: 2,
                        },
                    },
                    limit: 10,
                })
                const empty = candidates.find(
                    (c) =>
                        c.messages.length === 0 ||
                        (c.messages.length === 1 && !c.messages[0].is_user)
                )
                return empty?.id
            }

            export const chatNewestId = async (charId: number): Promise<number | undefined> => {
                const result = await database.query.chats.findFirst({
                    orderBy: desc(chats.last_modified),
                    where: eq(chats.character_id, charId),
                })
                return result?.id
            }

            export const chatNewest = async () => {
                const result = await database.query.chats.findFirst({
                    orderBy: desc(chats.last_modified),
                })
                return result
            }

            export const chatList = async (charId: number) => {
                const result = await database
                    .select({
                        ...getTableColumns(chats),
                        entryCount: count(chatEntries.id),
                    })
                    .from(chats)
                    .leftJoin(chatEntries, eq(chats.id, chatEntries.chat_id))
                    .groupBy(chats.id)
                    .where(eq(chats.character_id, charId))
                return result
            }

            export const chatListQuery = (charId: number) => {
                return database
                    .select({
                        ...getTableColumns(chats),
                        entryCount: count(chatEntries.id),
                    })
                    .from(chats)
                    .leftJoin(chatEntries, eq(chats.id, chatEntries.chat_id))
                    .groupBy(chats.id)
                    .where(eq(chats.character_id, charId))
                    .orderBy(desc(chats.last_modified))
            }

            export const chatExists = async (chatId: number) => {
                return await database.query.chats.findFirst({ where: eq(chats.id, chatId) })
            }

            export const searchChat = async (
                query: string,
                charId: number
            ): Promise<ChatSearchResult[]> => {
                const swipesWithIndex = sql`
                    SELECT
                        ${chatSwipes.id} AS swipeId,
                        ${chatSwipes.entry_id} AS entryId,
                        ${chatSwipes.swipe},
                        ${chatSwipes.send_date} AS sendDate,
                        ROW_NUMBER() OVER (PARTITION BY ${chatSwipes.entry_id} ORDER BY ${chatSwipes.id}) AS swipeIndex
                    FROM ${chatSwipes}
                    `

                const result = (await database
                    .select({
                        swipeId: sql`swipeId`,
                        chatId: chatEntries.chat_id,
                        chatEntryId: chatEntries.id,
                        chatName: chats.name,
                        swipe: sql`swipe`,
                        sendDate: sql`sendDate`,
                    })
                    .from(chatEntries)
                    .innerJoin(
                        sql`(${swipesWithIndex}) AS swi`,
                        sql`swi.entryId = ${chatEntries.id} AND swi.swipeIndex = ${chatEntries.swipe_id} + 1`
                    )
                    .innerJoin(chats, eq(chatEntries.chat_id, chats.id))
                    .where(and(like(sql`swipe`, `%${query}%`), eq(chats.character_id, charId)))
                    .orderBy(sql`sendDate`)
                    .limit(100)) as ChatSearchQueryResult[]

                return result.map((item) => {
                    return { ...item, sendDate: new Date(item.sendDate * 1000) }
                })
            }

            export const chatWithoutId = async (chatId: number, limit?: number) => {
                return await database.query.chats.findFirst({
                    where: eq(chats.id, chatId),
                    columns: { id: false },
                    with: {
                        messages: {
                            columns: { id: false },
                            with: {
                                swipes: {
                                    columns: { id: false },
                                },
                            },
                            ...(limit && { limit: limit }),
                        },
                    },
                })
            }

            export const chatLatestSwipe = async (chatId: number) => {
                const result = await database.query.chatEntries.findFirst({
                    where: eq(chatEntries.chat_id, chatId),
                    orderBy: desc(chatEntries.id),
                    with: {
                        swipes: true,
                    },
                })
                if (!result) return null
                return result.swipes?.[0]
            }

            export const chatName = async (chatId: number) => {
                const result = await database.query.chats.findFirst({
                    columns: { name: true },
                    where: eq(chats.id, chatId),
                })
                if (result) return result.name
            }
        }
        export namespace mutate {
            export const createChat = async (charId: number) => {
                const card = await Characters.db.query.card(charId)
                if (!card) {
                    Logger.error('Character does not exist!')
                    return
                }
                const userId = Characters.useUserStore.getState().id
                const charName = card.name
                return await database.transaction(async (tx) => {
                    if (!card || charName === undefined) return
                    const [{ chatId }] = await tx
                        .insert(chats)
                        .values({
                            character_id: charId,
                            user_id: userId ?? null,
                        })
                        .returning({ chatId: chats.id })

                    // custom setting to not generate first mes
                    if (!mmkv.getBoolean(AppSettings.CreateFirstMes)) return chatId
                    const greetings = [
                        card.first_mes ?? '',
                        ...card.alternate_greetings.map((item) => item.greeting),
                    ].filter((item) => item)

                    if (greetings.length > 0) {
                        const [{ entryId }] = await tx
                            .insert(chatEntries)
                            .values({
                                chat_id: chatId,
                                is_user: false,
                                name: card.name ?? '',
                                order: 0,
                            })
                            .returning({ entryId: chatEntries.id })

                        await tx.insert(chatSwipes).values(
                            greetings.map((item, index) => ({
                                entry_id: entryId,
                                active: index === 0,
                                swipe: convertToFormatInstruct(replaceMacros(item)),
                            }))
                        )
                    }

                    await Characters.db.mutate.updateModified(charId)
                    return chatId
                })
            }

            export const updateChatModified = async (chatID: number) => {
                const chat = await database.query.chats.findFirst({ where: eq(chats.id, chatID) })
                if (chat?.character_id) {
                    await Characters.db.mutate.updateModified(chat.character_id)
                }
                await database
                    .update(chats)
                    .set({ last_modified: Date.now() })
                    .where(eq(chats.id, chatID))
            }

            export const createEntry = async (
                chatId: number,
                name: string,
                isUser: boolean,
                message: string,
                attachments: AttachmentPayload[] = []
            ) => {
                // Atomic: entry + swipe + attachments roll back together so a failed
                // attachment cannot leave an orphan message with zero attachments.
                return await database.transaction(async (tx) => {
                    const { order } = (await tx.query.chatEntries.findFirst({
                        where: eq(chatEntries.chat_id, chatId),
                        orderBy: desc(chatEntries.id),
                        columns: { order: true },
                    })) ?? { order: 0 }

                    const [{ entryId }] = await tx
                        .insert(chatEntries)
                        .values({ chat_id: chatId, name, is_user: isUser, order })
                        .returning({ entryId: chatEntries.id })

                    const [{ swipeId }] = await tx
                        .insert(chatSwipes)
                        .values({ swipe: replaceMacros(message), entry_id: entryId, active: true })
                        .returning({ swipeId: chatSwipes.id })
                    await deactivateOtherSwipes(tx, entryId, swipeId)

                    // Sequential on purpose: a single failure aborts the transaction
                    // immediately instead of racing other inserts.
                    for (const att of attachments) {
                        await createAttachment(entryId, att, tx)
                    }

                    await updateChatModified(chatId)

                    const entry = await tx.query.chatEntries.findFirst({
                        where: eq(chatEntries.id, entryId),
                        with: { swipes: true, attachments: true },
                    })
                    return entry
                })
            }

            export const updateEntryModified = async (entryId: number) => {
                const entry = await database.query.chatEntries.findFirst({
                    where: eq(chatEntries.id, entryId),
                })
                if (entry?.chat_id) {
                    await updateChatModified(entry.chat_id)
                }
            }

            export const createSwipe = async (entryId: number, message: string) => {
                const [swipe] = await database
                    .insert(chatSwipes)
                    .values({
                        entry_id: entryId,
                        swipe: replaceMacros(message),
                        active: true,
                    })
                    .returning()
                await updateEntryModified(entryId)
                await deactivateOtherSwipes(database, entryId, swipe.id)
                return swipe
            }

            export const activateSwipe = async (swipeId: number) => {
                const [{ entryId }] = await database
                    .update(chatSwipes)
                    .set({ active: true })
                    .where(eq(chatSwipes.id, swipeId))
                    .returning({ entryId: chatSwipes.entry_id })

                await deactivateOtherSwipes(database, entryId, swipeId)
            }

            type TxOrDb = Pick<typeof database, 'update' | 'insert'>

            const deactivateOtherSwipes = async (
                txOrDb: TxOrDb,
                entryId: number,
                swipeId: number
            ) => {
                await txOrDb
                    .update(chatSwipes)
                    .set({ active: false })
                    .where(and(eq(chatSwipes.entry_id, entryId), not(eq(chatSwipes.id, swipeId))))
            }

            export const updateChatSwipe = async (
                chatSwipeId: number,
                message: string,
                options: UpdateChatSwipeOptions = {}
            ) => {
                if (!chatSwipeId) return

                const { updateFinished, updateStarted, timings, resetTimings } = options
                const date = new Date()
                const tokenizer = Tokenizer.getTokenizer()
                const updatedSwipe: ChatSwipeUpdated = {
                    id: chatSwipeId,
                    swipe: message,
                    token_length: await tokenizer(message).catch(() => 0),
                }

                if (updateFinished) updatedSwipe.gen_finished = date
                if (updateStarted) updatedSwipe.gen_started = date
                if (timings) updatedSwipe.timings = timings
                if (resetTimings) updatedSwipe.timings = null

                await database
                    .update(chatSwipes)
                    .set(updatedSwipe)
                    .where(eq(chatSwipes.id, chatSwipeId))

                const swipe = await database.query.chatSwipes.findFirst({
                    where: eq(chatSwipes.id, chatSwipeId),
                })

                if (swipe?.entry_id) updateEntryModified(swipe.entry_id)
            }

            /**
             * Lightweight mid-stream checkpoint: writes ONLY the text (no
             * tokenizer run, no modified-timestamp cascade). Used by the
             * periodic flush so an abnormal termination loses at most the last
             * checkpoint interval of a reply.
             */
            export const checkpointSwipeText = async (swipeId: number, text: string) => {
                if (!swipeId) return
                await database
                    .update(chatSwipes)
                    .set({ swipe: text })
                    .where(eq(chatSwipes.id, swipeId))
            }

            export const updateSwipeResetLength = async (swipeId: number, length: number) => {
                await database
                    .update(chatSwipes)
                    .set({ reset_length: length })
                    .where(eq(chatSwipes.id, swipeId))
            }

            export const updateSwipeTokenLength = async (swipeId: number, length: number) => {
                await database
                    .update(chatSwipes)
                    .set({ token_length: length })
                    .where(eq(chatSwipes.id, swipeId))
            }

            export const deleteChat = async (chatId: number) => {
                await updateChatModified(chatId)
                await database.delete(chats).where(eq(chats.id, chatId))
            }

            export const deleteChatEntry = async (entryId: number) => {
                await updateEntryModified(entryId)
                const attachments = await database.query.chatAttachments.findMany({
                    where: eq(chatAttachments.chat_entry_id, entryId),
                })
                await Promise.all(attachments.map(async (item) => deleteFile(item.uri)))

                await database.delete(chatEntries).where(eq(chatEntries.id, entryId))
            }

            export const cloneChat = async (
                chat: NonNullable<Awaited<ReturnType<typeof query.chatWithoutId>>>
            ) => {
                chat.last_modified = Date.now()

                const newChatId = await database.transaction(async (tx) => {
                    const [{ newChatId }] = await tx
                        .insert(chats)
                        .values(chat)
                        .returning({ newChatId: chats.id })

                    chat.messages.forEach((item) => {
                        item.chat_id = newChatId
                    })
                    const newEntryIds = await tx
                        .insert(chatEntries)
                        .values(chat.messages)
                        .returning({ newEntryId: chatEntries.id })

                    chat.messages.forEach((message, index) => {
                        message.swipes.forEach((swipe) => {
                            swipe.entry_id = newEntryIds[index].newEntryId
                        })
                    })
                    const swipes = chat.messages.map((item) => item.swipes).flat()
                    await tx.insert(chatSwipes).values(swipes)
                    return newChatId
                })
                return newChatId
            }

            export const cloneChatFromId = async (chatId: number, limit?: number) => {
                const result = await query.chatWithoutId(chatId, limit)
                if (!result) return

                result.last_modified = Date.now()
                const newChatid = await cloneChat(result)
                return newChatid
            }

            export const renameChat = async (chatId: number, name: string) => {
                await database.update(chats).set({ name: name }).where(eq(chats.id, chatId))
            }

            export const updateUser = async (chatId: number, userId: number) => {
                await database.update(chats).set({ user_id: userId }).where(eq(chats.id, chatId))
            }

            /**
             * Persists an attachment for an entry.
             *
             * Android frequently under-provisions picker/camera results: content://
             * URIs without an extension, a null fileName, or a missing mimeType.
             * Identity is therefore rebuilt through a cascade — every step falls
             * through to the next until the file can be provisioned:
             *   1. explicit mimeType provided by the picker asset
             *   2. mime lookup on the provided display name
             *   3. mime lookup on the source uri
             *   4. content sniffing of the file's magic bytes
             * The stored extension is derived from the resolved mime type when the
             * name/uri disagree with it (or carry none), so the copied file in the
             * attachments directory is always consistent for the vision pipeline.
             *
             * Throws on unrecoverable failures so the createEntry transaction rolls
             * back the whole message instead of leaving an orphan bubble.
             */
            export const createAttachment = async (
                entryId: number,
                att: AttachmentPayload,
                tx: Pick<typeof database, 'insert'> = database
            ) => {
                const attachmentId = randomUUID()
                const info = fileInfo(att.uri)
                if (!info.exists) {
                    throw new Error(`attachment source missing: ${att.uri}`)
                }

                const uriName = att.uri.split('/').pop() ?? ''
                const givenName =
                    typeof att.name === 'string' && att.name.trim() ? att.name.trim() : ''

                // -- MIME cascade --------------------------------------------------
                let sourceB64: string | null = null
                let mimeType: string | null = att.mimeType?.trim() || null
                if (!mimeType && givenName) mimeType = mime.getType(givenName)
                if (!mimeType) mimeType = mime.getType(att.uri)
                if (!mimeType) {
                    // Last resort: sniff the magic bytes. Android content providers
                    // can hand over files with no name and no type at all.
                    try {
                        sourceB64 = await readBase64Async(att.uri)
                        mimeType = sniffMimeType(sourceB64)
                    } catch (e) {
                        Logger.warn(`[createAttachment] content sniff failed: ${e}`)
                    }
                }

                const type = mimeType?.split('/')?.[0]
                if (!mimeType || !type || !validExtensionTypes(type)) {
                    throw new Error(
                        `invalid attachment: mime=${mimeType} name=${givenName || uriName}`
                    )
                }

                // -- Extension cascade ---------------------------------------------
                const extOf = (n: string) =>
                    n.includes('.') ? (n.split('.').pop()?.toLowerCase() ?? '') : ''
                const mimeExtension = mime.getExtension(mimeType)
                let extension = extOf(givenName) || extOf(uriName)
                // Rectify: if the name-derived extension disagrees with the resolved
                // mime type (or is absent), trust the mime type.
                if (!extension || (mimeExtension && mime.getType(extension) !== mimeType)) {
                    extension = mimeExtension ?? extension
                }
                if (!extension) {
                    throw new Error(`could not resolve extension for mime=${mimeType}`)
                }

                // -- Display name cascade ------------------------------------------
                const name = givenName || uriName || `${attachmentId}.${extension}`

                // The attachments dir is created by the startup routine, but a
                // fresh install (or a cleared data dir) can reach this path before
                // that async routine lands. If the dir is missing, File.copy()
                // throws DestinationDoesNotExist — guarantee it here.
                if (!ensureDirectoryExists(AppDirectory.Attachments)) {
                    throw new Error(`attachments directory unavailable`)
                }

                const newURI = AppDirectory.Attachments + attachmentId + '.' + extension

                // copyFile awaits the native copy AND verifies the destination
                // exists — a false here means the bytes are NOT on disk, which
                // must fail the message (thumbnail and vision payload would both
                // read this exact path later).
                const copied = await copyFile({ from: att.uri, to: newURI })
                if (!copied) {
                    throw new Error(`copy failed: ${att.uri} -> ${newURI}`)
                }

                // v2: populate content hash + size + dimensions so external tools
                // can match the attachment to the real photo library without
                // pulling the binaries.
                let sha256: string | null = null
                let size = att.size || info.size || 0
                let width = att.width ?? 0
                let height = att.height ?? 0
                try {
                    // Read from the SOURCE uri (guaranteed to exist — fileInfo
                    // succeeded above) rather than the just-copied file, and reuse
                    // the sniff read when present. The copy is byte-identical.
                    const b64 = sourceB64 ?? (await readBase64Async(att.uri))
                    sha256 = await Crypto.digestStringAsync(
                        Crypto.CryptoDigestAlgorithm.SHA256,
                        b64
                    )
                    if (width === 0 || height === 0) {
                        const dims = getImageDimensions(b64)
                        width = dims?.width ?? 0
                        height = dims?.height ?? 0
                    }
                    if (!size) {
                        // base64 → byte length (subtract padding)
                        const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
                        size = Math.floor((b64.length * 3) / 4) - padding
                    }
                } catch (e) {
                    // Hash and dims are non-fatal — a missing sha256 should never
                    // block message delivery. The copy itself was verified above,
                    // so the stored file IS on disk regardless.
                    Logger.warn(`[createAttachment] hash/dims failed (non-fatal): ${e}`)
                }

                const [attachment] = await tx
                    .insert(chatAttachments)
                    .values({
                        type: type,
                        name: name,
                        chat_entry_id: entryId,
                        uri: newURI,
                        mime_type: mimeType,
                        size: size,
                        sha256: sha256,
                        width: width,
                        height: height,
                    })
                    .returning()
                return attachment
            }

            export const deleteAttachment = async (attachmentId: number) => {
                await database.delete(chatAttachments).where(eq(chatAttachments.id, attachmentId))
            }

            export const updateScrollOffset = async (chatId: number, scrollOffset: number) => {
                await database
                    .update(chats)
                    .set({ scroll_offset: scrollOffset })
                    .where(eq(chats.id, chatId))
            }
        }

        export namespace live {
            export const entryIdList = (chatId: number) => {
                return database.query.chatEntries.findMany({
                    where: eq(chatEntries.chat_id, chatId),
                    columns: {
                        id: true,
                    },
                    orderBy: desc(chatEntries.id),
                })
            }

            export const entry = (entryId: number) => {
                return database.query.chatEntries.findFirst({
                    where: eq(chatEntries.id, entryId),
                    with: {
                        attachments: true,
                        swipes: {
                            limit: 1,
                            where: eq(chatSwipes.active, true),
                        },
                    },
                })
            }

            export const activeSwipeByEntry = (entryId: number) => {
                return database.query.chatSwipes.findFirst({
                    where: and(eq(chatSwipes.entry_id, entryId), eq(chatSwipes.active, true)),
                })
            }

            export const swipeIdList = (entryId: number) => {
                return database.query.chatSwipes.findMany({
                    where: eq(chatSwipes.entry_id, entryId),
                    columns: {
                        id: true,
                    },
                    orderBy: chatSwipes.id,
                })
            }

            export const tokenCount = (chatId: number) => {
                return database
                    .select({
                        totalTokens: sum(chatSwipes.token_length),
                    })
                    .from(chatSwipes)
                    .innerJoin(chatEntries, eq(chatSwipes.entry_id, chatEntries.id))
                    .where(and(eq(chatEntries.chat_id, chatId), eq(chatSwipes.active, true)))
            }

            export type LiveEntry = NonNullable<Awaited<ReturnType<typeof entry>>>
        }
    }

    const EMPTY_BUFFER: OutputBuffer = { data: '' }

    export const useBuffer = (swipeId: number) => {
        const buffer = Chats.useChatState((state) => state.buffers[swipeId] ?? EMPTY_BUFFER)
        return { buffer }
    }

    export const useChat = () => {
        const props = useChatState(
            useShallow((state) => ({
                chatId: state.id,
                scrollData: state.scrollData,
                setId: state.setId,
                resetId: state.reset,
            }))
        )
        return props
    }

    const validExtensionTypes = (type: string) => {
        //TODO: Add document, eg application/pdf or text/plain
        return type === 'audio' || type === 'image'
    }
}

// Persist all in-flight stream text whenever the app leaves the foreground.
// Android may kill a backgrounded process at any time; without this, buffers
// only reached SQLite at stream end or on chat switch (field trace: replies
// held in memory for 6+ minutes, and killed streams lost their text entirely).
AppState.addEventListener('change', (nextState) => {
    if (nextState === 'background' || nextState === 'inactive') {
        if (useInference.getState().nowGenerating) {
            Chats.useChatState
                .getState()
                .flushBufferToDb()
                .catch((e) => Logger.warn(`[AppState flush] failed: ${Logger.formatError(e)}`))
        }
    }
})
