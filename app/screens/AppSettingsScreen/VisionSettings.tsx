import React from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'
import { useMMKVBoolean } from 'react-native-mmkv'

import ThemedCheckbox from '@components/input/ThemedCheckbox'
import ThemedSwitch from '@components/input/ThemedSwitch'
import SectionTitle from '@components/text/SectionTitle'
import { AppSettings } from '@lib/constants/GlobalValues'
import { Theme } from '@lib/theme/ThemeManager'

const VisionSettings = () => {
    const { t } = useTranslation()
    const { color, spacing } = Theme.useTheme()
    const [disableCamera, setDisableCamera] = useMMKVBoolean(AppSettings.DisableCamera)
    const [sendOnAttach, setSendOnAttach] = useMMKVBoolean(AppSettings.SendOnAttach)
    const [switchContextOnSend, setSwitchContextOnSend] = useMMKVBoolean(
        AppSettings.SwitchContextOnSend
    )
    const [chainCapture, setChainCapture] = useMMKVBoolean(AppSettings.ChainCapture)
    const [rememberPickerPosition, setRememberPickerPosition] = useMMKVBoolean(
        AppSettings.RememberPickerPosition
    )
    const [singleImageGuard, setSingleImageGuard] = useMMKVBoolean(AppSettings.SingleImageGuard)

    // Chain Capture is experimental and only functions when the full
    // pick → send → switch pipeline is enabled.
    const chainGateOpen = !!(disableCamera && sendOnAttach && switchContextOnSend)

    return (
        <View style={{ rowGap: 8 }}>
            <SectionTitle>
                {t('settings.vision.title', { defaultValue: 'Vision & Attachments' })}
            </SectionTitle>

            <ThemedSwitch
                label={t('settings.vision.disableCamera', { defaultValue: 'Disable Camera' })}
                value={disableCamera}
                onChangeValue={setDisableCamera}
                description={t('settings.vision.disableCameraDescription', {
                    defaultValue:
                        'Removes the camera from the attachment menu — the attach button opens the image picker directly',
                })}
            />

            <ThemedSwitch
                label={t('settings.vision.sendOnAttach', { defaultValue: 'Send when Attached' })}
                value={sendOnAttach}
                onChangeValue={setSendOnAttach}
                description={t('settings.vision.sendOnAttachDescription', {
                    defaultValue:
                        'Automatically sends the message as soon as images are picked — no extra tap on Send',
                })}
            />

            <ThemedSwitch
                label={t('settings.vision.switchContextOnSend', {
                    defaultValue: 'Switch Context on Send',
                })}
                value={switchContextOnSend}
                onChangeValue={setSwitchContextOnSend}
                description={t('settings.vision.switchContextOnSendDescription', {
                    defaultValue:
                        'After a send completes, moves to a fresh conversation while the reply streams in the background. Does not send by itself — combine with Send when Attached for pick → send → new context',
                })}
            />

            <Text
                style={{
                    color: color.text._400,
                    marginTop: spacing.m,
                    fontStyle: 'italic',
                }}>
                {t('settings.vision.experimentalTitle', {
                    defaultValue: 'Experimental — Android pipeline',
                })}
            </Text>

            <ThemedSwitch
                label={t('settings.vision.chainCapture', {
                    defaultValue: 'Chain Capture (2-press loop)',
                })}
                value={chainGateOpen ? chainCapture : false}
                onChangeValue={(b) => {
                    if (chainGateOpen) setChainCapture(b)
                }}
                description={
                    chainGateOpen
                        ? t('settings.vision.chainCaptureDescription', {
                              defaultValue:
                                  'After a chained send, automatically reopens the image picker: tap image → tap OK → sent + new chat + picker is back. Cancel/back in the picker exits the loop',
                          })
                        : t('settings.vision.chainCaptureGated', {
                              defaultValue:
                                  'Requires Disable Camera + Send when Attached + Switch Context on Send all enabled',
                          })
                }
            />

            <ThemedCheckbox
                label={t('settings.vision.rememberPickerPosition', {
                    defaultValue: 'Remember last picker position',
                })}
                value={!!rememberPickerPosition}
                onChangeValue={setRememberPickerPosition}
            />
            <Text style={{ color: color.text._400, marginBottom: spacing.m }}>
                {t('settings.vision.rememberPickerPositionDescription', {
                    defaultValue:
                        'Uses the classic Android gallery picker, which keeps your scroll position (July, June, …) between launches. The modern Photo Picker always reopens at Recents',
                })}
            </Text>

            <ThemedCheckbox
                label={t('settings.vision.singleImageGuard', {
                    defaultValue: 'Guard against multi-image sends',
                })}
                value={!!singleImageGuard}
                onChangeValue={setSingleImageGuard}
            />
            <Text style={{ color: color.text._400, marginBottom: spacing.m }}>
                {t('settings.vision.singleImageGuardDescription', {
                    defaultValue:
                        'Refuses to send when more than one image is attached and puts the picker in single-select mode',
                })}
            </Text>
        </View>
    )
}

export default VisionSettings
