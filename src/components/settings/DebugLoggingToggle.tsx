import React from 'react';
import { View, Text, Switch, TouchableOpacity } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { AnimatedEntry } from '../AnimatedEntry';
import { useAppStore } from '../../stores';
import { useTheme, useThemedStyles } from '../../theme';
import type { ThemeColors } from '../../theme';
import { TYPOGRAPHY, SPACING } from '../../constants';

/**
 * "Debug logging" row on the Settings screen. Captures logger output to the
 * on-device log file + Debug Logs viewer, including in release builds where
 * dev logging is off. Off by default — also reveals the Debug Logs viewer.
 */
export const DebugLoggingToggle: React.FC<{ trigger: number }> = ({ trigger }) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const debugLogging = useAppStore((s) => s.settings.debugLogging);
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <AnimatedEntry index={2} staggerMs={40} trigger={trigger}>
      <View style={styles.row}>
        <View style={styles.textCol}>
          <Text style={styles.label}>Debug logging</Text>
          <Text style={styles.desc}>Save diagnostic logs on this device</Text>
        </View>
        <Switch
          testID="debug-logging-toggle"
          value={debugLogging}
          onValueChange={(v) => updateSettings({ debugLogging: v })}
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

/**
 * Log viewer button for release builds with debug logging on (dev builds
 * have the full dev tooling group on the Settings screen instead).
 */
export const ReleaseDebugLogsButton: React.FC<{ trigger: number; onOpen: () => void }> = ({
  trigger,
  onOpen,
}) => {
  const { colors } = useTheme();
  const styles = useThemedStyles(createButtonStyles);
  const debugLogging = useAppStore((s) => s.settings.debugLogging);
  if (__DEV__ || !debugLogging) return null;
  return (
    <AnimatedEntry index={11} staggerMs={40} trigger={trigger}>
      <View style={styles.group}>
        <TouchableOpacity style={styles.button} onPress={onOpen}>
          <Icon name="terminal" size={14} color={colors.textMuted} />
          <Text style={styles.buttonText}>Debug Logs</Text>
        </TouchableOpacity>
      </View>
    </AnimatedEntry>
  );
};

const createButtonStyles = (colors: ThemeColors) => ({
  group: { gap: 12 },
  button: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
    marginTop: SPACING.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed' as const,
    borderRadius: 6,
  },
  buttonText: { ...TYPOGRAPHY.bodySmall, color: colors.textMuted },
});
