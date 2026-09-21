import type { ThemeColors, ThemeShadows } from '../theme/palettes';
import { SPACING, TYPOGRAPHY } from '../constants';

export function createStyles(colors: ThemeColors, _shadows: ThemeShadows) {
  return {
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backButton: {
      padding: 8,
      marginRight: 8,
    },
    title: {
      ...TYPOGRAPHY.h2,
      color: colors.text,
      flex: 1,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      padding: 16,
    },
    switchRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: SPACING.md,
      padding: SPACING.md,
      marginBottom: SPACING.md,
      borderRadius: 12,
      backgroundColor: colors.surfaceLight,
    },
    switchTextCol: {
      flex: 1,
    },
    switchTitle: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      marginBottom: 2,
    },
    switchDesc: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.textSecondary,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
    },
    cardTitle: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      marginBottom: 8,
    },
    statusRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: 6,
      marginBottom: 4,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    statusDotActive: {
      backgroundColor: colors.success,
    },
    statusDotInactive: {
      backgroundColor: colors.textMuted,
    },
    statusText: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.textSecondary,
    },
    urlText: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.primary,
      marginTop: 4,
    },
    metaText: {
      ...TYPOGRAPHY.meta,
      color: colors.textMuted,
      marginTop: 4,
    },
    errorText: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.error,
      marginTop: 4,
    },
    fieldLabel: {
      ...TYPOGRAPHY.label,
      color: colors.textSecondary,
      marginBottom: 6,
      marginTop: 4,
    },
    textInput: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      backgroundColor: colors.surfaceLight,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 4,
    },
    optionRow: {
      flexDirection: 'row' as const,
      gap: 8,
      marginBottom: 4,
    },
    optionButton: {
      flex: 1,
      alignItems: 'center' as const,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: colors.surfaceLight,
    },
    optionButtonActive: {
      backgroundColor: colors.primary,
    },
    optionButtonText: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.text,
    },
    optionButtonTextActive: {
      color: colors.background,
    },
    fileButton: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: SPACING.sm,
      backgroundColor: colors.surfaceLight,
      borderRadius: 8,
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginBottom: 8,
    },
    fileButtonText: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.text,
      flex: 1,
    },
    fingerprintBox: {
      backgroundColor: colors.surfaceLight,
      borderRadius: 8,
      padding: 12,
      marginTop: 4,
    },
    fingerprintText: {
      ...TYPOGRAPHY.meta,
      color: colors.textSecondary,
    },
    regenerateButton: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 6,
      paddingVertical: 10,
      marginTop: 8,
      borderRadius: 8,
      backgroundColor: colors.surfaceLight,
    },
    regenerateButtonText: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.text,
    },
    warningBanner: {
      flexDirection: 'row' as const,
      gap: SPACING.sm,
      backgroundColor: colors.errorBackground,
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
    },
    warningText: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.error,
      flex: 1,
    },
    stayRunningText: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.textSecondary,
      lineHeight: 20,
      marginBottom: 8,
    },
    infoCard: {
      backgroundColor: colors.surfaceLight,
      borderRadius: 12,
      padding: 16,
      marginTop: 4,
    },
    infoTitle: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      marginBottom: 8,
    },
    infoText: {
      ...TYPOGRAPHY.bodySmall,
      color: colors.textSecondary,
      lineHeight: 20,
    },
  };
}
