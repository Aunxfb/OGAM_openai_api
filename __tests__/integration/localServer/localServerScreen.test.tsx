/**
 * Local Server screen — rendered integration test.
 *
 * Mounts the real LocalServerScreen, flips the real on/off switch, and
 * asserts what the user SEES (status text, URL, warning banner). The ONLY
 * fake is the native module at the device boundary (stands in for the
 * Kotlin socket server); the service, store, and navigation are real.
 */
import React from 'react';
import { NativeModules } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { LocalServerScreen } from '../../../src/screens/LocalServerScreen';
import { resetStores } from '../../utils/testHelpers';

function installFakeNative() {
  (NativeModules as unknown as Record<string, unknown>).LocalServerModule = {
    start: jest.fn(async () => ({
      running: true,
      urls: ['http://127.0.0.1:8080'],
      requestsServed: 0,
      lastError: null,
      capabilities: { backgroundServe: true, wakeLock: true },
    })),
    stop: jest.fn(async () => {}),
    getStatus: jest.fn(async () => ({
      running: false,
      urls: [],
      requestsServed: 0,
      lastError: null,
      capabilities: { backgroundServe: true, wakeLock: true },
    })),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
}

function renderScreen() {
  return render(
    <NavigationContainer>
      <LocalServerScreen />
    </NavigationContainer>,
  );
}

describe('LocalServerScreen', () => {
  beforeEach(() => {
    resetStores();
    installFakeNative();
  });

  it('toggles the server on and off, showing status and URL', async () => {
    const screen = renderScreen();

    expect(screen.getByText('Local Server')).toBeTruthy();
    expect(screen.getByTestId('local-server-status')).toHaveTextContent('Stopped');

    fireEvent(screen.getByTestId('local-server-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(screen.getByTestId('local-server-status')).toHaveTextContent('Running');
    });
    expect(screen.getByTestId('local-server-url')).toHaveTextContent('http://127.0.0.1:8080');

    fireEvent(screen.getByTestId('local-server-toggle'), 'valueChange', false);

    await waitFor(() => {
      expect(screen.getByTestId('local-server-status')).toHaveTextContent('Stopped');
    });
  });

  it('warns about open LAN access without an API key', () => {
    const screen = renderScreen();

    expect(screen.queryByText('No API key set. Anyone on your network can use this server.')).toBeNull();

    fireEvent.press(screen.getByTestId('local-server-bind-all'));

    expect(
      screen.getByText('No API key set. Anyone on your network can use this server.'),
    ).toBeTruthy();
  });

  it('refuses an out-of-range port without touching native', async () => {
    const screen = renderScreen();

    fireEvent.changeText(screen.getByTestId('local-server-port'), '80');
    fireEvent(screen.getByTestId('local-server-toggle'), 'valueChange', true);

    await waitFor(() => {
      expect(screen.getByText('Invalid Port')).toBeTruthy();
    });
    const native = NativeModules.LocalServerModule as { start: jest.Mock };
    expect(native.start).not.toHaveBeenCalled();
  });
});
