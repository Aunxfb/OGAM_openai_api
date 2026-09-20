import React from 'react';
import { View, Text, Switch } from 'react-native';
import { AnimatedEntry } from '../AnimatedEntry';
import { useAppStore } from '../../stores';
import { useTheme, useThemedStyles } from '../../theme';
import type { ThemeColors } from '../../theme';
import { TYPOGRAPHY, SPACING } from '../../constants';

/**
 * "Hide promotions" row on the Settings screen. Suppresses all PRO and
 * Off Grid AI Desktop promos app-wide (banners, cards, upsell panels,
 * entry rows, and inline desktop links). Off by default.
 */
export const HidePromotionsToggle: React.FC<{ trigger: number }> = ({ trigger }) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const hidePromotions = useAppStore((s) => s.settings.hidePromotions);
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <AnimatedEntry index={1} staggerMs={40} trigger={trigger}>
      <View style={styles.row}>
        <View style={styles.textCol}>
          <Text style={styles.label}>Hide promotions</Text>
          <Text style={styles.desc}>Hide all PRO and Desktop promos</Text>
        </View>
        <Switch
          testID="hide-promotions-toggle"
          value={hidePromotions}
          onValueChange={(v) => updateSettings({ hidePromotions: v })}
          trackColor={{ false: colors.border, true: colors.primary }}
        />
      </View>
    </AnimatedEntry>
  );
};

const createStyles = (colors: ThemeColors) => ({
  row: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: SPACING.md,
    marginBottom: SPACING.lg,
  },
  textCol: { flex: 1, marginRight: SPACING.md },
  label: { ...TYPOGRAPHY.body, color: colors.text },
  desc: { ...TYPOGRAPHY.bodySmall, color: colors.textMuted, marginTop: 2 },
});
