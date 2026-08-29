import AntDesign from '@react-native-vector-icons/ant-design/static'
import MaterialIcons from '@react-native-vector-icons/material-icons/static'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Text, View } from 'react-native'
import * as Progress from 'react-native-progress'

import { SamplerID, Samplers } from '@lib/constants/SamplerData'
import { useContextLimit } from '@lib/hooks/ContextLimit'
import { Theme } from '@lib/theme/ThemeManager'

interface ContextLimitPreviewProps {
    generatedLength: number
}

const ContextLimitPreview: React.FC<ContextLimitPreviewProps> = ({ generatedLength }) => {
    const { t } = useTranslation()
    const { color } = Theme.useTheme()
    const contextLimit = useContextLimit()

    // Slider pinned to its maximum = UNCAPPED: the cap is omitted from the
    // request so the provider/model ceiling applies. Indicators go red as a
    // visual cue that no app-side limit is enforced.
    const genValues = Samplers[SamplerID.GENERATED_LENGTH].values
    const ctxValues = Samplers[SamplerID.CONTEXT_LENGTH].values
    const genUncapped =
        (genValues.type === 'integer' || genValues.type === 'float') &&
        generatedLength >= genValues.max
    const ctxUncapped =
        (ctxValues.type === 'integer' || ctxValues.type === 'float') &&
        contextLimit >= ctxValues.max
    const uncapped = genUncapped || ctxUncapped

    const leftover = Math.max(0, contextLimit - generatedLength)
    const limit = leftover / contextLimit
    const warning = !uncapped && leftover < Math.min(2048, 0.25 * contextLimit)
    const genLengthColor = uncapped
        ? color.error._400
        : warning
          ? color.error._300
          : color.primary._200

    return (
        <View
            style={{
                borderRadius: 8,
                padding: 12,
                marginHorizontal: 4,
                rowGap: 8,
                borderWidth: 2,
                borderColor: uncapped ? color.error._400 : color.primary._200,
            }}>
            <Text style={{ color: color.text._100 }}>
                {t('contextlimit.allocation')}{' '}
                <Text style={{ color: color.text._400 }}>
                    (
                    {ctxUncapped
                        ? t('contextlimit.nolimit', { defaultValue: 'No Limit' })
                        : contextLimit}
                    )
                </Text>
            </Text>
            <Progress.Bar
                progress={uncapped ? 1 : limit}
                color={uncapped ? color.error._400 : color.primary._400}
                borderColor={color.neutral._300}
                height={12}
                unfilledColor={genLengthColor}
                borderRadius={12}
                width={null}
            />
            <View style={{ flexDirection: 'row', columnGap: 4, alignItems: 'center' }}>
                {warning || uncapped ? (
                    <AntDesign
                        name={'exclamation-circle'}
                        size={16}
                        style={{
                            color: color.error._400,
                        }}
                    />
                ) : (
                    <MaterialIcons
                        name="circle"
                        size={16}
                        style={{
                            color: color.primary._400,
                        }}
                    />
                )}
                <Text style={{ color: color.text._400, textAlign: 'center' }}>
                    {t('contextlimit.chat')}: {uncapped ? '—' : leftover}
                </Text>
                <MaterialIcons
                    name="circle"
                    size={16}
                    style={{
                        color: genLengthColor,
                        marginLeft: 12,
                    }}
                />
                <Text
                    style={{
                        color: genUncapped ? color.error._300 : color.text._400,
                        textAlign: 'center',
                    }}>
                    {t('contextlimit.generated')}:{' '}
                    {genUncapped
                        ? t('contextlimit.nolimit', { defaultValue: 'No Limit' })
                        : generatedLength}
                </Text>
            </View>
            {uncapped && (
                <Text style={{ color: color.error._300 }}>
                    {t('contextlimit.uncappedWarning', {
                        defaultValue:
                            'Set to maximum — no app-side limit is applied; the model/provider ceiling decides',
                    })}
                </Text>
            )}
            {warning && (
                <Text style={{ color: color.error._300 }}>{t('contextlimit.warning')}</Text>
            )}
        </View>
    )
}

export default ContextLimitPreview
