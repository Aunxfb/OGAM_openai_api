import React from 'react';
import { useAppStore } from '../../stores';
import { SegmentedRow, BOOL_OPTIONS } from './segmentedRow';

/**
 * Skip RAM safety clamps on context budgets (LiteRT clamp, llama step-down
 * and device cap). The loader then grants the raw request instead of what
 * free RAM can hold — the device may abort or crash mid-inference. Explicit
 * user override, off by default. Requires model reload.
 */
export const UnsafeContextToggle: React.FC = () => {
  const { settings, updateSettings } = useAppStore();
  return (
    <SegmentedRow<'off' | 'on'>
      label="Unsafe Context"
      description="Grant the full context request without RAM safety clamps. May crash the app mid-inference on large contexts. Requires model reload."
      options={BOOL_OPTIONS}
      current={settings.unsafeContext ? 'on' : 'off'}
      onSelect={(id: 'off' | 'on') => updateSettings({ unsafeContext: id === 'on' })}
      testIdFor={(id: 'off' | 'on') => `unsafe-context-${id}-button`}
    />
  );
};
