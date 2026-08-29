import AntDesign from '@react-native-vector-icons/ant-design/static'
import MaterialIcons from '@react-native-vector-icons/material-icons/static'
import { randomUUID } from 'expo-crypto'
import { Image } from 'expo-image'
import { launchImageLibraryAsync, requestMediaLibraryPermissionsAsync } from 'expo-image-picker'
import { router } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard, Pressable, TextInput, TouchableOpacity, View } from 'react-native'
import { useMMKVBoolean } from 'react-native-mmkv'
import Animated, {
    BounceIn,
    FadeIn,
    FadeOut,
    LinearTransition,
    ZoomOut,
} from 'react-native-reanimated'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import ThemedButton from '@components/buttons/ThemedButton'
import Alert from '@components/views/Alert'
import { useBottomSheetRef } from '@components/views/BottomSheet'
import CameraSheet from '@components/views/CameraSheet'
import ContextMenu from '@components/views/ContextMenu'
import { XAxisOnlyTransition } from '@lib/animations/transitions'
import { AppSettings } from '@lib/constants/GlobalValues'
import { generateResponse } from '@lib/engine/Inference'
import { useActiveProvider } from '@lib/hooks/ActiveProvider'
import { useUnfocusTextInput } from '@lib/hooks/UnfocusTextInput'
import { Characters } from '@lib/state/Characters'
import { Chats, useInference } from '@lib/state/Chat'
import { useChatInputTextStore } from '@lib/state/components/ChatInput'
import { Logger } from '@lib/state/Logger'
import { Theme } from '@lib/theme/ThemeManager'
import { ChainPickOutcome, PickerChain } from '@lib/utils/PickerChain'

import ChatOptions from './ChatInputOptions'

export type Attachment = {
    uri: string
    type: 'image' | 'audio' | 'document'
    name: string
    mimeType?: string | null
    size?: number
    width?: number
    height?: number
}

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput)

type ChatInputHeightStoreProps = {
    height: number
    setHeight: (n: number) => void
}

export const useInputHeightStore = create<ChatInputHeightStoreProps>()((set) => ({
    height: 54,
    setHeight: (n) => set({ height: Math.ceil(n) }),
}))

type PendingSend = {
    chatId: number
    text: string
    attachments: Attachment[]
    userName: string
    charName: string
}

const ChatInput = () => {
    const { t } = useTranslation()
    const inputRef = useUnfocusTextInput()
    const { available: activeProvider, mode } = useActiveProvider()
    const { color, borderRadius, spacing } = Theme.useTheme()
    const [sendOnEnter] = useMMKVBoolean(AppSettings.SendOnEnter)
    const [disableCamera] = useMMKVBoolean(AppSettings.DisableCamera)
    const [sendOnAttach] = useMMKVBoolean(AppSettings.SendOnAttach)
    const [switchContextOnSend] = useMMKVBoolean(AppSettings.SwitchContextOnSend)
    const [chainCapture] = useMMKVBoolean(AppSettings.ChainCapture)
    const [rememberPickerPosition] = useMMKVBoolean(AppSettings.RememberPickerPosition)
    const [singleImageGuard] = useMMKVBoolean(AppSettings.SingleImageGuard)
    const [disableSend, setDisableSend] = useState(false)
    const [attachments, setAttachments] = useState<Attachment[]>([])
    const [hideOptions, setHideOptions] = useState(false)
    const cameraSheetRef = useBottomSheetRef()
    const setHeight = useInputHeightStore(useShallow((state) => state.setHeight))

    const { chatId, setId } = Chats.useChat()

    // Generation state is scoped to THIS chat: other chats generating in the
    // background neither block sending here nor light up the stop button.
    const nowGenerating = useInference((state) => state.isChatGenerating(chatId))

    const { charName, charId } = Characters.useCharacterStore(
        useShallow((state) => ({
            charName: state?.card?.name,
            charId: state?.id,
        }))
    )

    const { userName } = Characters.useUserStore(
        useShallow((state) => ({ userName: state.card?.name }))
    )

    const { newMessage, setNewMessage } = useChatInputTextStore(
        useShallow((state) => ({
            newMessage: state.text,
            setNewMessage: state.setText,
        }))
    )

    const abortResponse = async () => {
        Logger.info(t('chat.input.errors.abortGeneration'))
        await useInference.getState().abortChat(chatId)
    }

    // Per-chat queue: sending while THIS chat is generating queues the message
    // and auto-fires it the moment THAT chat's stream ends. Combined with
    // per-swipe buffers this gives real parallelism: chat A can keep streaming
    // while you switch to chat B, attach an image and send.
    const pendingSendsRef = useRef<Map<number, PendingSend>>(new Map())

    const performSend = async (p: PendingSend) => {
        const {
            chatId: targetChatId,
            userName: senderName,
            charName: botName,
            text,
            attachments: atts,
        } = p
        try {
            if (text.trim() !== '' || atts.length > 0) {
                // Await + catch so a failed user message (e.g. attachment INSERT
                // failure) surfaces to the user instead of silently producing an
                // empty bubble. The transaction in createEntry rolls back the
                // whole message if any attachment fails.
                await Chats.db.mutate.createEntry(
                    targetChatId,
                    senderName,
                    true,
                    text,
                    atts.map((item) => ({
                        uri: item.uri,
                        name: item.name,
                        mimeType: item.mimeType,
                        size: item.size,
                        width: item.width,
                        height: item.height,
                    }))
                )
            }
            const result = await Chats.db.mutate.createEntry(targetChatId, botName, false, '')
            const swipeId = result?.swipes?.[0]?.id
            if (swipeId) await generateResponse(swipeId, targetChatId)
        } catch (e) {
            Logger.errorToast(t('chat.input.errors.failedToSend'))
            Logger.error(Logger.formatError(e))
            // If the user message was already committed but the assistant entry
            // failed, we do NOT roll back the user message (it is already visible
            // in the chat) — the user can simply regenerate.
        }
    }

    const performSendRef = useRef<(p: PendingSend) => Promise<void>>(async () => {})
    useEffect(() => {
        performSendRef.current = performSend
    })

    useEffect(() => {
        return useInference.subscribe((state) => {
            const map = pendingSendsRef.current
            if (!map.size) return
            for (const [cid, pending] of [...map.entries()]) {
                if (!state.isChatGenerating(cid)) {
                    map.delete(cid)
                    performSendRef.current(pending)
                }
            }
        })
    }, [])

    /**
     * Resolves the conversation to land in after a Switch-Context send.
     * REUSES the newest already-empty chat (no user messages) before creating
     * one — unconditional creation previously produced two chats per send and
     * left 45% of all chats permanently empty (forensic Bug 3).
     */
    const resolveLandingContext = async (): Promise<number | undefined> => {
        if (!charId) return
        try {
            const existing = await Chats.db.query.latestEmptyChatId(charId)
            if (existing) return existing
            return await Chats.db.mutate.createChat(charId)
        } catch (e) {
            Logger.errorToast(
                t('chat.input.errors.failedToSwitchContext', {
                    defaultValue: 'Failed to open new conversation',
                })
            )
            Logger.error(Logger.formatError(e))
        }
    }

    /**
     * @param overrideAttachments pass freshly picked attachments directly —
     * React state (`attachments`) has not committed yet when auto-send fires
     * from the picker callback.
     * @returns true when a send was actually dispatched/queued.
     */
    const handleSend = async (overrideAttachments?: Attachment[]): Promise<boolean> => {
        Keyboard.dismiss()
        if (!chatId) return false
        const sendAttachments = overrideAttachments ?? attachments
        // Single-image guard: refuse to send with more than one image
        // attached. Applies to every send path (manual, auto, chained).
        if (singleImageGuard) {
            const imageCount = sendAttachments.filter((a) => a.type === 'image').length
            if (imageCount > 1) {
                Logger.warnToast(
                    t('chat.input.errors.singleImageGuard', {
                        count: imageCount,
                        defaultValue:
                            'Single-image guard: {{count}} images attached — remove extras to send',
                    })
                )
                return false
            }
        }
        setDisableSend(true)
        try {
            const payload: PendingSend = {
                chatId,
                text: newMessage,
                attachments: sendAttachments,
                userName: userName ?? '',
                charName: charName ?? '',
            }

            if (switchContextOnSend) {
                // Switch Context on Send: dispatch THIS send, then move to a
                // clean conversation while the reply streams in the background.
                // It does NOT trigger sends by itself — stack it with
                // 'Send when Attached' for the pick → send → switch flow.
                if (nowGenerating) {
                    // The current chat is still streaming — put the job in its
                    // own conversation so both generate concurrently instead of
                    // queueing.
                    const jobChatId = await Chats.db.mutate.createChat(charId ?? -1)
                    if (!jobChatId) return false
                    payload.chatId = jobChatId
                }
                setNewMessage('')
                setAttachments([])
                // performSend resolves once the user message is committed and
                // the generation TASK is dispatched — it does NOT wait for the
                // reply stream, so the context switch below is immediate.
                await performSend(payload)
                // Land in an empty conversation: reuse one if it exists,
                // create only when none is available (no orphan-chat spam).
                const nextChatId = await resolveLandingContext()
                if (nextChatId && nextChatId !== payload.chatId) await setId(nextChatId)
                return true
            }

            if (nowGenerating) {
                // A generation is in flight in this chat — queue instead of
                // dropping the message. The subscription above sends it the
                // moment this chat's generation commits.
                pendingSendsRef.current.set(chatId, payload)
                setNewMessage('')
                setAttachments([])
                Logger.infoToast(
                    t('chat.input.queuedSend', {
                        defaultValue: 'Queued — sends when this reply finishes',
                    })
                )
                return true
            }
            setNewMessage('')
            setAttachments([])
            await performSend(payload)
            return true
        } finally {
            setDisableSend(false)
        }
    }

    // While generating, the button is the stop button; if the user has typed or
    // attached something, treat the press as a queued send instead of an abort.
    const handleStopOrQueue = () => {
        if (newMessage.trim() !== '' || attachments.length > 0) {
            handleSend()
        } else {
            abortResponse()
        }
    }

    /**
     * One picker round. Returns the outcome so the chain controller can
     * decide whether to relaunch. Throws only on LAUNCH failures (activity
     * not ready) — those are retried by PickerChain, never looped blindly.
     */
    const pickImageOnce = async (): Promise<ChainPickOutcome> => {
        const permissionResult = await requestMediaLibraryPermissionsAsync()

        if (!permissionResult.granted) {
            Alert.alert({
                title: t('common.errors.permissionRequired'),
                description: t('chat.input.errors.permissionDescription'),
                buttons: [
                    {
                        label: t('common.actions.close'),
                    },
                ],
            })
            return 'blocked'
        }

        const guardOn = !!singleImageGuard
        const result = await launchImageLibraryAsync({
            mediaTypes: ['images'],
            // Single-image guard also constrains the picker itself: Android's
            // Photo Picker enforces the limit natively in single-select mode.
            allowsMultipleSelection: !guardOn,
            ...(guardOn ? { selectionLimit: 1 } : {}),
            // Remember-position: the modern Android 13+ Photo Picker
            // (PickVisualMedia) is a system activity that ALWAYS reopens at
            // Recents — apps cannot influence its scroll state. The legacy
            // ACTION_GET_CONTENT gallery keeps the provider's own browsing
            // position (month/album scroll) across launches, which is what
            // historical batch work needs.
            legacy: !!rememberPickerPosition,
            aspect: [4, 3],
            quality: 1,
        })

        if (result.canceled) return 'canceled'

        // Android does not reliably provision fileName/mimeType for picked
        // assets — thread everything the picker DID provide and let the
        // attachment cascade in createAttachment rectify the rest. Dedupe on
        // uri (names may be missing or identical).
        const newAttachments: Attachment[] = result.assets
            .map((item) => ({
                uri: item.uri,
                type: 'image' as const,
                name: item.fileName || (item.uri.split('/').pop() ?? randomUUID().toString()),
                mimeType: item.mimeType ?? null,
                size: item.fileSize ?? 0,
                width: item.width ?? 0,
                height: item.height ?? 0,
            }))
            .filter((item) => !attachments.some((a) => a.uri === item.uri))

        const merged = [...attachments, ...newAttachments]
        setAttachments(merged)

        // 'Send when Attached' ONLY: the picker confirmation IS the send
        // action. 'Switch Context on Send' does NOT auto-send by itself — it
        // is a post-send behavior; enable both to stack them into the full
        // pick → send → fresh-context flow.
        // Pass the merged list directly: React state has not committed yet.
        if (sendOnAttach && merged.length > 0) {
            const sent = await handleSend(merged)
            return sent ? 'sent' : 'blocked'
        }
        return merged.length > 0 ? 'attached' : 'blocked'
    }

    // Chain capture: pick → auto-send → new context → auto-reopen picker.
    // HARD GATE: requires Disable Camera + Send when Attached + Switch
    // Context on Send all ON — read live from a ref at every chain step so
    // toggling any gate mid-loop stops the chain.
    const chainGateRef = useRef(false)
    const pickImageRef = useRef(pickImageOnce)
    useEffect(() => {
        chainGateRef.current = !!(
            chainCapture &&
            disableCamera &&
            sendOnAttach &&
            switchContextOnSend
        )
        pickImageRef.current = pickImageOnce
    })

    // One controller per mounted ChatInput, created lazily inside the event
    // handler (never during render, per React Compiler ref rules); disposed
    // on unmount so a pending chained relaunch can never fire into an
    // unmounted screen.
    const pickerChainRef = useRef<PickerChain | null>(null)

    useEffect(() => {
        return () => {
            pickerChainRef.current?.dispose()
            pickerChainRef.current = null
        }
    }, [])

    const handlePickImage = async () => {
        if (!pickerChainRef.current) {
            pickerChainRef.current = new PickerChain({
                pick: () => pickImageRef.current(),
                shouldChain: () => chainGateRef.current,
                onError: (e) => {
                    Logger.warn(`[ChainCapture] picker launch failed: ${Logger.formatError(e)}`)
                },
            })
        }
        await pickerChainRef.current.run()
    }

    return (
        <Pressable
            onPress={() => {
                if (activeProvider) return
                if (mode === 'local') {
                    router.push('/screens/ModelManagerScreen')
                } else router.push('/screens/ConnectionsManagerScreen')
            }}
            onLayout={(e) => {
                setHeight(e.nativeEvent.layout.height)
            }}
            disabled={activeProvider}
            style={{
                position: 'absolute',
                width: '98%',
                alignSelf: 'center',
                bottom: 4,
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.sm,
                backgroundColor: color.neutral._100 + 'cc',
                borderWidth: 1,
                borderColor: color.neutral._200,
                boxShadow: [
                    {
                        offsetX: 1,
                        offsetY: 1,
                        color: color.shadow,
                        spreadDistance: 1,
                        blurRadius: 4,
                    },
                ],
                borderRadius: 16,
                rowGap: spacing.m,
            }}>
            <Animated.FlatList
                itemLayoutAnimation={LinearTransition}
                style={{
                    display: attachments.length > 0 ? 'flex' : 'none',
                    padding: spacing.l,
                    backgroundColor: color.neutral._200,
                    borderRadius: borderRadius.m,
                }}
                horizontal
                contentContainerStyle={{ columnGap: spacing.xl }}
                data={attachments}
                keyExtractor={(item) => item.uri}
                renderItem={({ item }) => {
                    return (
                        <Animated.View
                            entering={BounceIn}
                            exiting={ZoomOut.duration(100)}
                            style={{ alignItems: 'center', rowGap: 8 }}>
                            <Image
                                source={{ uri: item.uri }}
                                style={{
                                    width: 128,
                                    height: undefined,
                                    aspectRatio: 1,
                                    borderRadius: borderRadius.m,
                                    borderWidth: 1,
                                    borderColor: color.primary._500,
                                }}
                            />

                            <ThemedButton
                                iconName="close"
                                iconSize={20}
                                buttonStyle={{
                                    borderWidth: 0,
                                    paddingHorizontal: 2,
                                    paddingVertical: 2,
                                    position: 'absolute',
                                    alignSelf: 'flex-end',
                                    margin: -8,
                                    backgroundColor: color.neutral._500,
                                }}
                                onPress={() => {
                                    setAttachments(attachments.filter((a) => a.uri !== item.uri))
                                }}
                            />
                        </Animated.View>
                    )
                }}
            />
            <CameraSheet
                onTakePicture={(picture) => {
                    setAttachments((attachments) => [
                        ...attachments,
                        {
                            name: randomUUID().toString() + '.jpg',
                            uri: picture.uri,
                            type: 'image',
                            mimeType: 'image/jpeg',
                            width: picture.width ?? 0,
                            height: picture.height ?? 0,
                        },
                    ])
                }}
                ref={cameraSheetRef}
            />
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    columnGap: spacing.m,
                }}>
                <Animated.View layout={XAxisOnlyTransition}>
                    {!hideOptions && (
                        <Animated.View
                            entering={FadeIn}
                            exiting={FadeOut}
                            style={{
                                flexDirection: 'row',
                                columnGap: 8,
                                alignItems: 'center',
                            }}>
                            <ChatOptions disabled={!activeProvider} />
                            {disableCamera === false ? (
                                <ContextMenu
                                    disabled={!activeProvider}
                                    triggerIcon="paper-clip"
                                    triggerIconSize={20}
                                    buttons={[
                                        {
                                            label: t('chat.input.actions.takePicture'),
                                            icon: 'camera',
                                            onPress: (close) => {
                                                cameraSheetRef.current?.open()
                                                close()
                                            },
                                        },
                                        {
                                            label: t('chat.input.actions.addImage'),
                                            icon: 'picture',
                                            onPress: async (close) => {
                                                close()
                                                handlePickImage()
                                            },
                                        },
                                    ]}
                                    triggerStyle={{
                                        color: color.text._400,
                                        padding: 6,
                                        backgroundColor: color.neutral._200,
                                        borderRadius: 16,
                                        opacity: activeProvider ? 1 : 0.5,
                                    }}
                                    placement="top"
                                />
                            ) : (
                                // Camera disabled: adding an attachment is the only
                                // action, so skip the menu entirely.
                                <TouchableOpacity
                                    disabled={!activeProvider}
                                    onPress={handlePickImage}
                                    style={{
                                        padding: 6,
                                        backgroundColor: color.neutral._200,
                                        borderRadius: 16,
                                        opacity: activeProvider ? 1 : 0.5,
                                    }}>
                                    <AntDesign name="picture" color={color.text._400} size={20} />
                                </TouchableOpacity>
                            )}
                        </Animated.View>
                    )}
                    {hideOptions && (
                        <Animated.View entering={FadeIn} exiting={FadeOut}>
                            <ThemedButton
                                iconSize={18}
                                iconStyle={{
                                    color: color.text._400,
                                }}
                                buttonStyle={{
                                    padding: 5,
                                    backgroundColor: color.neutral._200,
                                    borderRadius: 32,
                                }}
                                variant="tertiary"
                                iconName="right"
                                onPress={() => setHideOptions(false)}
                            />
                        </Animated.View>
                    )}
                </Animated.View>
                <AnimatedTextInput
                    layout={XAxisOnlyTransition}
                    ref={inputRef}
                    style={{
                        color: color.text._100,
                        backgroundColor: color.neutral._100,
                        flex: 1,
                        borderWidth: 2,
                        borderColor: activeProvider ? color.primary._300 : color.primary._100,
                        borderRadius: borderRadius.l,
                        paddingHorizontal: spacing.m,
                        paddingVertical: spacing.m,
                    }}
                    onPress={() => {
                        setHideOptions(!!newMessage)
                    }}
                    numberOfLines={8}
                    placeholder={
                        activeProvider
                            ? t('chat.input.message')
                            : mode === 'local'
                              ? t('chat.input.noModelLoaded')
                              : t('chat.input.noConnection')
                    }
                    editable={activeProvider}
                    placeholderTextColor={color.text._700}
                    value={newMessage}
                    onChangeText={(text) => {
                        setHideOptions(!!text)
                        setNewMessage(text)
                    }}
                    multiline
                    submitBehavior={sendOnEnter ? 'blurAndSubmit' : 'newline'}
                    onSubmitEditing={sendOnEnter ? () => handleSend() : undefined}
                />
                <Animated.View layout={XAxisOnlyTransition}>
                    <TouchableOpacity
                        disabled={disableSend || !chatId || !activeProvider}
                        style={{
                            borderRadius: borderRadius.m,
                            backgroundColor: !activeProvider
                                ? color.neutral._100
                                : nowGenerating
                                  ? color.error._500
                                  : color.primary._500,
                            padding: spacing.s,
                            borderWidth: 2,
                            borderColor: !activeProvider
                                ? color.primary._100
                                : nowGenerating
                                  ? color.error._500
                                  : color.primary._500,
                        }}
                        onPress={nowGenerating ? handleStopOrQueue : () => handleSend()}>
                        <MaterialIcons
                            name={nowGenerating ? 'stop' : 'send'}
                            color={activeProvider ? color.neutral._100 : color.text._700}
                            size={24}
                        />
                    </TouchableOpacity>
                </Animated.View>
            </View>
        </Pressable>
    )
}

export default ChatInput
