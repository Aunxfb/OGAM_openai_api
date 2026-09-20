import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import type { Message } from '../../../types';
import { useTheme } from '../../../theme';
import { createStyles } from '../styles';
import { formatTime, formatDuration } from '../utils';
import { SyncedToolArtifacts, RoutedToolsRow } from './ToolMessages';
import { GenerationMeta } from './GenerationMeta';

type MetaRowProps = {
  message: Message;
  styles: ReturnType<typeof createStyles>;
  isStreaming?: boolean;
  showActions: boolean;
  onMenuOpen: () => void;
  metaExtra?: React.ReactNode;
};

const MessageMetaRow: React.FC<MetaRowProps> = ({
  message,
  styles,
  isStreaming,
  showActions,
  onMenuOpen,
  metaExtra,
}) => (
  <View testID="message-meta-row" style={styles.metaRow}>
    <Text style={styles.timestamp}>{formatTime(message.timestamp)}</Text>
    {message.generationTimeMs != null && message.role === 'assistant' && (
      <Text style={styles.generationTime}>
        {formatDuration(message.generationTimeMs)}
      </Text>
    )}
    {metaExtra}
    {showActions && !isStreaming && (
      <TouchableOpacity style={styles.actionHint} onPress={onMenuOpen}>
        <Text style={styles.actionHintText}>•••</Text>
      </TouchableOpacity>
    )}
  </View>
);

interface MessageBubbleFooterProps {
  message: Message;
  styles: ReturnType<typeof createStyles>;
  colors: ReturnType<typeof useTheme>['colors'];
  isUser: boolean;
  isStreaming?: boolean;
  showActions: boolean;
  showGenerationDetails: boolean;
  metaExtra?: React.ReactNode;
  onMenuOpen: () => void;
  toolsBeforeActiveThinking: boolean;
  showTurnFooter: boolean;
}

// The metadata + tool + cutoff footer below the bubble. Split out of MessageBubble
// so its conditionals don't inflate the bubble's complexity.
export const MessageBubbleFooter: React.FC<MessageBubbleFooterProps> = ({
  message,
  styles,
  colors,
  isUser,
  isStreaming,
  showActions,
  showGenerationDetails,
  metaExtra,
  onMenuOpen,
  toolsBeforeActiveThinking,
  showTurnFooter,
}) => (
  <>
    {!message.isThinking && (
      <MessageMetaRow
        message={message}
        styles={styles}
        isStreaming={isStreaming}
        showActions={showActions}
        onMenuOpen={onMenuOpen}
        metaExtra={metaExtra}
      />
    )}

    {!toolsBeforeActiveThinking && (
      <SyncedToolArtifacts
        message={message}
        styles={styles}
        colors={colors}
      />
    )}

    {showTurnFooter && (
      <RoutedToolsRow
        message={message}
        isUser={isUser}
        isStreaming={isStreaming}
        styles={styles}
        colors={colors}
      />
    )}

    {showTurnFooter && message.generationMeta?.truncated && (
      <View testID="message-cutoff-indicator" style={styles.toolStatusRow}>
        <Icon name="alert-triangle" size={12} color={colors.textMuted} />
        <Text style={styles.toolStatusText}>
          Reply cut off at the token limit. Retry to continue.
        </Text>
      </View>
    )}

    {showTurnFooter && showGenerationDetails && message.generationMeta && (
      <GenerationMeta
        messageId={message.id}
        generationMeta={message.generationMeta}
        styles={styles}
        colors={colors}
      />
    )}
  </>
);
