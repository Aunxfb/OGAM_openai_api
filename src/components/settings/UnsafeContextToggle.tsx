import React from 'react';
import { useAppStore } from '../../stores';
import { SegmentedRow, BOOL_OPTIONS } from './segmentedRow';

/**
 * Skip the native RAM clamp on the LiteRT context budget. The loader then
 * grants the raw Max Tokens request instead of what free RAM can hold — the
 * device may abort or crash mid-inference. Explicit user override, off by
 * default. Requires model reload.
 */
export const UnsafeContextToggle: React.FC = () => {
  const { settings, updateSettings } = useAppStore();
  return (
    <SegmentedRow<'off' | 'on'>
      label="Unsafe Context (LiteRT)"
      description="Grant the full Max Tokens request without the RAM safety clamp. May crash the app mid-inference on large contexts. Requires model reload."
      options={BOOL_OPTIONS}
      current={settings.liteRTUnsafeContext ? 'on' : 'off'}
      onSelect={(id: 'off' | 'on') => updateSettings({ liteRTUnsafeContext: id === 'on' })}
      testIdFor={(id: 'off' | 'on') => `unsafe-context-${id}-button`}
    />
  );
};
