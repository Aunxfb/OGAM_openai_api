/**
 * Local Server Settings Screen.
 *
 * Controls the on-device llama-server: on/off switch, status, port, bind
 * scope, TLS mode, and the optional Bearer key. Dispatches intents on the
 * owning LocalServerService and renders the persisted config + status
 * projection from the store. No inference logic lives here.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  TextInput,
  Platform,
  PermissionsAndroid,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getIpAddress } from 'react-native-device-info';
import { pick, types, isErrorWithCode, errorCodes } from '@react-native-documents/picker';
import { useTheme, useThemedStyles } from '../theme';
import { useAppStore } from '../stores';
import { localServerService } from '../services/localServer/LocalServerService';
import {
  consumeLocalServerOpenRequest,
  getLocalServerFingerprint,
  regenerateLocalServerCertificate,
} from '../services/localServer/contract';
import type {
  LocalServerBindMode,
  LocalServerTlsMode,
} from '../services/localServer/types';
import { isValidLocalServerPort } from '../services/localServer/types';
import { resolvePickedFileUri } from '../utils/resolvePickedFileUri';
import { CustomAlert, AlertState, initialAlertState, showAlert } from '../components/CustomAlert';
import { RootStackParamList } from '../navigation/types';
import { createStyles } from './LocalServerScreen.styles';

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'LocalServer'>;

const BIND_OPTIONS: { mode: LocalServerBindMode; label: string }[] = [
  { mode: 'loopback', label: 'This phone' },
  { mode: 'interface', label: 'Wi-Fi' },
  { mode: 'all', label: 'All' },
];

const TLS_OPTIONS: { mode: LocalServerTlsMode; label: string }[] = [
  { mode: 'off', label: 'Off' },
  { mode: 'byoc', label: 'My cert' },
  { mode: 'self-signed', label: 'Self-signed' },
];

export const LocalServerScreen: React.FC = () => {
  const navigation = useNavigation<NavigationProp>();
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const config = useAppStore(s => s.localServer);
  const status = useAppStore(s => s.localServerStatus);
  const setConfig = useAppStore(s => s.setLocalServerConfig);

  const [busy, setBusy] = useState(false);
  const [portText, setPortText] = useState(String(config.port));
  const [apiKeyText, setApiKeyText] = useState(config.apiKey);
  const [lanIp, setLanIp] = useState('');
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [alertState, setAlertState] = useState<AlertState>(initialAlertState);

  useEffect(() => {
    setPortText(String(config.port));
  }, [config.port]);

  useEffect(() => {
    setApiKeyText(config.apiKey);
  }, [config.apiKey]);

  useEffect(() => {
    consumeLocalServerOpenRequest().catch(() => {});
    // getIpAddress is absent on builds without the device-info native module;
    // the LAN row simply stays hidden there.
    if (typeof getIpAddress !== 'function') return;
    getIpAddress()
      .then(ip => {
        if (typeof ip === 'string' && ip.length > 0) setLanIp(ip);
      })
      .catch(() => {});
  }, []);

  const refreshFingerprint = useCallback(() => {
    if (config.tlsMode !== 'self-signed') {
      setFingerprint(null);
      return;
    }
    getLocalServerFingerprint()
      .then(fp => setFingerprint(fp))
      .catch(() => setFingerprint(null));
  }, [config.tlsMode]);

  useEffect(() => {
    refreshFingerprint();
  }, [refreshFingerprint]);

  const fail = useCallback((title: string, message: string) => {
    setAlertState(showAlert(title, message, [{ text: 'Dismiss', style: 'cancel' }]));
  }, []);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (busy) return;
      if (!next) {
        setBusy(true);
        try {
          await localServerService.stop();
        } finally {
          setBusy(false);
        }
        return;
      }
      const port = Number.parseInt(portText, 10);
      if (!isValidLocalServerPort(port)) {
        fail('Invalid Port', 'Port must be a number from 1024 to 65535.');
        return;
      }
      if (config.bindMode === 'interface' && !config.interfaceIp && !lanIp) {
        fail('No Wi-Fi Address', 'Connect to Wi-Fi first, then turn the server on.');
        return;
      }
      setBusy(true);
      try {
        if (Platform.OS === 'android' && Platform.Version >= 33) {
          try {
            await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
          } catch {
            // The server still starts; only the ongoing notification stays hidden.
          }
        }
        setConfig({
          port,
          apiKey: apiKeyText.trim(),
          interfaceIp: config.bindMode === 'interface' ? config.interfaceIp || lanIp : '',
        });
        await localServerService.start();
        if (localServerService.getState() === 'error') {
          const lastError = useAppStore.getState().localServerStatus.lastError;
          fail('Server Did Not Start', lastError ?? 'Unknown error.');
        }
      } finally {
        setBusy(false);
      }
    },
    [apiKeyText, busy, config.bindMode, config.interfaceIp, fail, lanIp, portText, setConfig],
  );

  const handlePickFile = useCallback(
    async (kind: 'cert' | 'key') => {
      try {
        const results = await pick({ type: [types.allFiles], allowMultiSelection: false });
        const file = results[0];
        if (!file?.uri) return;
        const path = await resolvePickedFileUri(file.uri, file.name ?? `${kind}.pem`);
        setConfig(kind === 'cert' ? { certPath: path } : { keyPath: path });
      } catch (err) {
        if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) return;
        fail('File Not Readable', err instanceof Error ? err.message : 'Could not read that file.');
      }
    },
    [fail, setConfig],
  );

  const handleRegenerate = useCallback(() => {
    setAlertState(
      showAlert(
        'Regenerate Certificate',
        'Clients that pinned the old fingerprint must trust the new one.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Regenerate',
            style: 'destructive',
            onPress: async () => {
              const fp = await regenerateLocalServerCertificate();
              if (fp) setFingerprint(fp);
              else fail('Regenerate Failed', 'The certificate could not be regenerated.');
            },
          },
        ],
      ),
    );
  }, [fail]);

  const running = status.running;
  const showKeyWarning = !config.apiKey && config.bindMode !== 'loopback';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Icon name="chevron-left" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Local Server</Text>
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        <View style={styles.switchRow}>
          <View style={styles.switchTextCol}>
            <Text style={styles.switchTitle}>Serve this phone's model</Text>
            <Text style={styles.switchDesc}>
              Other devices on your network can use the loaded model through an OpenAI-style API.
            </Text>
          </View>
          <Switch
            testID="local-server-toggle"
            value={running}
            disabled={busy}
            onValueChange={handleToggle}
            trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Status</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, running ? styles.statusDotActive : styles.statusDotInactive]} />
            <Text testID="local-server-status" style={styles.statusText}>
              {running ? 'Running' : 'Stopped'}
            </Text>
          </View>
          {status.urls.map(url => (
            <Text key={url} testID="local-server-url" style={styles.urlText}>
              {url}
            </Text>
          ))}
          {running && (
            <Text style={styles.metaText}>Requests served: {status.requestsServed}</Text>
          )}
          {status.lastError && (
            <Text testID="local-server-error" style={styles.errorText}>
              {status.lastError}
            </Text>
          )}
        </View>

        {showKeyWarning && (
          <View style={styles.warningBanner}>
            <Icon name="alert-triangle" size={16} color={theme.colors.error} />
            <Text style={styles.warningText}>
              No API key set. Anyone on your network can use this server.
            </Text>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Port</Text>
          <TextInput
            testID="local-server-port"
            style={styles.textInput}
            value={portText}
            onChangeText={setPortText}
            keyboardType="number-pad"
            placeholder="8080"
            placeholderTextColor={theme.colors.textMuted}
            editable={!running}
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Listen on</Text>
          <View style={styles.optionRow}>
            {BIND_OPTIONS.map(opt => {
              const active = config.bindMode === opt.mode;
              return (
                <TouchableOpacity
                  key={opt.mode}
                  testID={`local-server-bind-${opt.mode}`}
                  style={[styles.optionButton, active && styles.optionButtonActive]}
                  onPress={() => {
                    setConfig({
                      bindMode: opt.mode,
                      interfaceIp: opt.mode === 'interface' ? lanIp : '',
                    });
                  }}
                  disabled={running}
                >
                  <Text style={[styles.optionButtonText, active && styles.optionButtonTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {lanIp.length > 0 && (
            <Text style={styles.metaText}>This phone on Wi-Fi: {lanIp}</Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Security (HTTPS)</Text>
          <View style={styles.optionRow}>
            {TLS_OPTIONS.map(opt => {
              const active = config.tlsMode === opt.mode;
              return (
                <TouchableOpacity
                  key={opt.mode}
                  testID={`local-server-tls-${opt.mode}`}
                  style={[styles.optionButton, active && styles.optionButtonActive]}
                  onPress={() => setConfig({ tlsMode: opt.mode })}
                  disabled={running}
                >
                  <Text style={[styles.optionButtonText, active && styles.optionButtonTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {config.tlsMode === 'byoc' && (
            <>
              <Text style={styles.fieldLabel}>CERTIFICATE FILE</Text>
              <TouchableOpacity
                testID="local-server-pick-cert"
                style={styles.fileButton}
                onPress={() => handlePickFile('cert')}
                disabled={running}
              >
                <Icon name="file" size={16} color={theme.colors.textSecondary} />
                <Text style={styles.fileButtonText} numberOfLines={1}>
                  {config.certPath || 'Choose certificate'}
                </Text>
              </TouchableOpacity>
              <Text style={styles.fieldLabel}>KEY FILE</Text>
              <TouchableOpacity
                testID="local-server-pick-key"
                style={styles.fileButton}
                onPress={() => handlePickFile('key')}
                disabled={running}
              >
                <Icon name="file" size={16} color={theme.colors.textSecondary} />
                <Text style={styles.fileButtonText} numberOfLines={1}>
                  {config.keyPath || 'Choose key'}
                </Text>
              </TouchableOpacity>
            </>
          )}
          {config.tlsMode === 'self-signed' && (
            <View style={styles.fingerprintBox}>
              <Text style={styles.fieldLabel}>FINGERPRINT</Text>
              <Text testID="local-server-fingerprint" style={styles.fingerprintText}>
                {fingerprint ?? 'Start the server once to create it.'}
              </Text>
              <TouchableOpacity
                testID="local-server-regenerate"
                style={styles.regenerateButton}
                onPress={handleRegenerate}
                disabled={running}
              >
                <Icon name="refresh-cw" size={16} color={theme.colors.text} />
                <Text style={styles.regenerateButtonText}>Regenerate</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>API key (optional)</Text>
          <TextInput
            testID="local-server-apikey"
            style={styles.textInput}
            value={apiKeyText}
            onChangeText={setApiKeyText}
            onEndEditing={() => setConfig({ apiKey: apiKeyText.trim() })}
            placeholder="Leave empty for open access"
            placeholderTextColor={theme.colors.textMuted}
            secureTextEntry
            autoCapitalize="none"
            editable={!running}
          />
        </View>

        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>About the local server</Text>
          <Text style={styles.infoText}>
            Serves the model loaded on this phone at an OpenAI-style API, the same shape desktop
            tools use against llama-server. It stays up with the screen off on Android. An iPhone
            build is not part of this change. Opening the server address in a browser shows
            a status page.
          </Text>
        </View>
      </ScrollView>

      <CustomAlert {...alertState} onClose={() => setAlertState(initialAlertState)} />
    </SafeAreaView>
  );
};
