import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelMetadataManager } from '../model-metadata-manager';

describe('ModelMetadataManager – auto-refresh toggle', () => {
  let mgr: ModelMetadataManager;

  beforeEach(() => {
    ModelMetadataManager.resetForTesting();
    mgr = ModelMetadataManager.getInstance();
    vi.useFakeTimers();
  });

  afterEach(() => {
    mgr.stopAutoRefresh();
    vi.useRealTimers();
  });

  it('does not auto-refresh by default (no timer set)', () => {
    // The default state has no setInterval, so the timer handle is null.
    expect(Reflect.get(mgr, 'autoRefreshTimer')).toBeNull();
  });

  it('setAutoRefreshEnabled(true) starts a 60-minute interval', () => {
    void mgr.setAutoRefreshEnabled(true);
    const timer = Reflect.get(mgr, 'autoRefreshTimer') as ReturnType<typeof setInterval> | null;
    expect(timer).not.toBeNull();
  });

  it('setAutoRefreshEnabled(false) clears any existing interval', () => {
    void mgr.setAutoRefreshEnabled(true);
    expect(Reflect.get(mgr, 'autoRefreshTimer')).not.toBeNull();
    void mgr.setAutoRefreshEnabled(false);
    expect(Reflect.get(mgr, 'autoRefreshTimer')).toBeNull();
  });

  it('setAutoRefreshEnabled(true) is idempotent when already scheduled', () => {
    void mgr.setAutoRefreshEnabled(true);
    const first = Reflect.get(mgr, 'autoRefreshTimer');
    void mgr.setAutoRefreshEnabled(true);
    const second = Reflect.get(mgr, 'autoRefreshTimer');
    // Should keep the same timer rather than stacking a new one.
    expect(first).toBe(second);
  });
});
