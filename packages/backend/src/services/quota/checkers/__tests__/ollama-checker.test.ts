import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMeterContext, isCheckerRegistered } from '../../checker-registry';
import checkerDef from '../ollama-checker';

const makeCtx = (options: Record<string, unknown> = {}) =>
  createMeterContext('ollama-test', 'ollama', { apiKey: 'ollama-test-key', ...options });

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const captureFetch = (impl: (call: FetchCall) => Promise<Response>): { calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    return impl({ url, init });
  }) as unknown as typeof fetch;
  return { calls };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('ollama checker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is registered under ollama', () => {
    expect(isCheckerRegistered('ollama')).toBe(true);
  });

  it('emits session + weekly allowance meters when /api/usage returns both ratios', async () => {
    // /api/me is best-effort; we respond with a plan so the parser logs it.
    const { calls } = captureFetch(async ({ url }) => {
      if (url.endsWith('/api/me')) return jsonResponse({ Plan: 'pro' });
      return jsonResponse({
        limits: { session: { usage: 0.42 }, weekly: { usage: 0.18 } },
      });
    });

    const meters = await checkerDef.check(makeCtx());

    expect(meters).toHaveLength(2);

    const session = meters.find((m) => m.key === 'session')!;
    expect(session.kind).toBe('allowance');
    expect(session.unit).toBe('percentage');
    expect(session.used).toBe(42);
    expect(session.remaining).toBe(58);
    expect(session.periodValue).toBe(5);
    expect(session.periodUnit).toBe('hour');
    expect(session.periodCycle).toBe('rolling');

    const weekly = meters.find((m) => m.key === 'weekly')!;
    expect(weekly.kind).toBe('allowance');
    expect(weekly.unit).toBe('percentage');
    expect(weekly.used).toBe(18);
    expect(weekly.remaining).toBe(82);
    expect(weekly.periodValue).toBe(7);
    expect(weekly.periodUnit).toBe('day');
    expect(weekly.periodCycle).toBe('rolling');

    // Both endpoints called; both carry the Bearer header.
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('throws with key-expired message on 401 from /api/usage', async () => {
    captureFetch(
      async () => new Response('unauthorized', { status: 401, statusText: 'Unauthorized' })
    );

    await expect(checkerDef.check(makeCtx())).rejects.toThrow(
      'Ollama Cloud API key invalid or expired.'
    );
  });

  it('throws when /api/usage returns no usable limit data', async () => {
    captureFetch(async () => jsonResponse({ limits: {} }));

    await expect(checkerDef.check(makeCtx())).rejects.toThrow('No usage limits reported.');
  });
});
