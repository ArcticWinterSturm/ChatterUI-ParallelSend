import AntDesign from '@react-native-vector-icons/ant-design/static'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FlatList, Linking, Pressable, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useShallow } from 'zustand/react/shallow'

import ThemedButton from '@components/buttons/ThemedButton'
import Aicons, { AiconsGlyphName } from '@components/icons/Aicons'
import BottomSheet, { BottomSheetRef } from '@components/views/BottomSheet'
import { APIConfiguration } from '@lib/engine/API/APIBuilder.types'
import { APIManager } from '@lib/engine/API/APIManagerState'
import { defaultTemplates } from '@lib/engine/API/DefaultAPI'
import useAnimatedActiveColorStyle from '@lib/hooks/AnimatedActiveColorStyle'
import { Theme } from '@lib/theme/ThemeManager'

type TemplatePickerProps = {
    ref: BottomSheetRef
    setPending: (index: number) => void
}

const TemplateItem: React.FC<{
    config: APIConfiguration
    onPress: () => void
    selected: boolean
}> = ({ config, onPress, selected }) => {
    const { color, borderWidth, spacing, fontSize } = Theme.useTheme()

    const animatedStyle = useAnimatedActiveColorStyle({
        deactiveColor: color.neutral._200,
        activeColor: color.primary._500,
        active: selected,
    })

    // eslint-disable-next-line i18next/no-literal-string
    const icon = config.ui.display?.icon ?? 'link'
    const name = config.ui.display?.name ?? config.name
    const description = config.ui.display?.description
    const link = config.ui.display?.link

    return (
        <Animated.View
            style={[
                {
                    borderWidth: borderWidth.m,
                    borderRadius: spacing.xl,
                },
                animatedStyle,
            ]}>
            <Pressable
                style={{
                    minHeight: 64,
                    paddingLeft: spacing.xl,
                    paddingRight: spacing.xl,
                    paddingVertical: spacing.m,
                    alignItems: 'center',
                    flexDirection: 'row',
                    columnGap: 12,
                    flex: 1,
                }}
                onPress={onPress}>
                {icon && (
                    <Aicons
                        style={{ minWidth: 32, alignSelf: 'center' }}
                        name={icon as AiconsGlyphName}
                        size={24}
                        color={color.text._400}
                    />
                )}
                <View style={{ flex: 1, marginRight: link ? 0 : 16 }}>
                    <Text style={{ color: color.text._100, fontSize: fontSize.l }}>{name}</Text>
                    {description && <Text style={{ color: color.text._400 }}>{description}</Text>}
                </View>
                {link && (
                    <Pressable onPress={() => Linking.openURL(link)}>
                        <AntDesign name={'info-circle'} color={color.text._400} size={20} />
                    </Pressable>
                )}
            </Pressable>
        </Animated.View>
    )
}

const TemplatePicker: React.FC<TemplatePickerProps> = ({ ref, setPending }) => {
    const { t } = useTranslation()
    const [selected, setSelected] = useState<number | undefined>()
    const { color, fontSize, spacing } = Theme.useTheme()
    const { addValue, valuesLength, customTemplates } = APIManager.useConnectionsStore(
        useShallow((state) => ({
            addValue: state.addValue,
            valuesLength: state.values.length,
            customTemplates: state.customTemplates,
        }))
    )

    // `getTemplates` is a stable store function — memoizing on it alone froze
    // this list for the lifetime of the component, so a template imported in
    // Template Manager did not appear here until a full screen remount
    // (exit to menu and back). Build from the subscribed template data instead.
    const templates = useMemo(
        () =>
            [...defaultTemplates, ...customTemplates].sort(
                (a, b) => (b.ui.display?.priority ?? 0) - (a.ui.display?.priority ?? 0)
            ),
        [customTemplates]
    )

    return (
        <BottomSheet
            ref={ref}
            onClose={() => setSelected(undefined)}
            sheetStyle={{ maxHeight: '80%' }}>
            <Text
                style={{
                    color: color.text._100,
                    paddingBottom: spacing.xl,
                    fontSize: fontSize.xl,
                }}>
                {t('connections.add.title')}
            </Text>
            <FlatList
                data={templates}
                keyExtractor={(item) => item.name}
                renderItem={({ item, index }) => (
                    <TemplateItem
                        config={item}
                        selected={selected === index}
                        onPress={() => {
                            setSelected(selected === index ? undefined : index)
                        }}
                    />
                )}
                contentContainerStyle={{
                    rowGap: 8,
                    paddingBottom: 32,
                }}
                showsVerticalScrollIndicator={false}
            />

            <View style={{ paddingTop: 12 }}>
                <ThemedButton
                    disabled={selected === undefined}
                    label={t('common.actions.create')}
                    onPress={() => {
                        // `selected` is an index — 0 is valid (was `!selected`,
                        // which made the first template impossible to create)
                        if (selected === undefined) return
                        const template = templates.at(selected)
                        if (!template) return
                        addValue({
                            ...template.defaultValues,
                            active: true,
                            configName: template.name,
                            friendlyName: t('connections.add.defaultFriendlyName'),
                        })
                        setPending(valuesLength)
                        ref.current?.close()
                    }}
                    variant={selected === undefined ? 'disabled' : 'primary'}
                />
            </View>
        </BottomSheet>
    )
}

export default TemplatePicker
