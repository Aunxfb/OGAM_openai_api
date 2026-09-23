/**
 * Debug logging opt-in — rendered test.
 *
 * Mounts the real SettingsScreen, flips the real Debug logging switch, and
 * asserts what the user SEES: the persisted flag turns on and the Debug Logs
 * viewer button appears (the release path to captured logs). Real store, no
 * mocks of our own code.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { SettingsScreen } from '../../../src/screens/SettingsScreen';
import { useAppStore } from '../../../src/stores/appStore';
import { resetStores } from '../../utils/testHelpers';

// Navigation is globally mocked in jest.setup.ts

describe('DebugLoggingToggle', () => {
  beforeEach(() => {
    resetStores();
  });

  it('flips the persisted flag and reveals the log viewer button', () => {
    const screen = render(<SettingsScreen />);

    expect(useAppStore.getState().settings.debugLogging).toBe(false);

    fireEvent(screen.getByTestId('debug-logging-toggle'), 'valueChange', true);

    expect(useAppStore.getState().settings.debugLogging).toBe(true);
    expect(screen.getByText('Debug Logs')).toBeTruthy();
  });
});
