import { describe, expect, test, beforeEach, vi } from 'vitest';
import { ProbeService } from '../probes/probe-service';
import { Dispatcher } from '../dispatch/dispatcher';
import { UsageStorageService } from '../observability/usage-storage';
import { setConfigForTesting } from '../../config';

function makeMocks() {
  const usageStorage = {
    saveRequest: vi.fn(async () => {}),
    saveError: vi.fn(),
    emitStartedAsync: vi.fn(),
    emitUpdatedAsync: vi.fn(),
  } as unknown as UsageStorageService;

  const dispatcher = {
    dispatch: vi.fn(async () => ({
      id: 'r',
      model: 'test-model',
      created: Date.now(),
      content: 'ok',
      usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
      plexus: {
        provider: 'p1',
        model: 'm1',
        apiType: 'chat',
        canonicalModel: 'm1',
        attemptCount: 1,
      },
    })),
    dispatchEmbeddings: vi.fn(),
    dispatchImageGenerations: vi.fn(),
    dispatchSpeech: vi.fn(),
  } as unknown as Dispatcher;

  return { usageStorage, dispatcher };
}

describe('ProbeService', () => {
  beforeEach(() => {
    setConfigForTesting({
      providers: {},
      models: {},
      keys: {},
      failover: {
        enabled: false,
        retryableStatusCodes: [],
        retryableErrors: [],
      },
      quotas: [],
    } as any);
  });

  test('runProbe builds direct/<provider>/<model> model string for chat', async () => {
    const { usageStorage, dispatcher } = makeMocks();
    const svc = new ProbeService(dispatcher, usageStorage);

    await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'chat',
      source: 'background',
    });

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const unified = (dispatcher.dispatch as any).mock.calls[0][0];
    expect(unified.model).toBe('direct/p1/m1');
    expect(unified.incomingApiType).toBe('chat');
  });

  test('runProbe records apiKey="probe" and attribution from source', async () => {
    const { usageStorage, dispatcher } = makeMocks();
    const svc = new ProbeService(dispatcher, usageStorage);

    await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'chat',
      source: 'manual',
    });

    expect(usageStorage.emitStartedAsync).toHaveBeenCalled();
    const started = (usageStorage.emitStartedAsync as any).mock.calls[0][0];
    expect(started.apiKey).toBe('probe');
    expect(started.attribution).toBe('manual');
    expect(started.incomingModelAlias).toBe('direct/p1/m1');

    const saved = (usageStorage.saveRequest as any).mock.calls[0][0];
    expect(saved.apiKey).toBe('probe');
    expect(saved.attribution).toBe('manual');
  });

  test('runProbe records attribution="background" for background source', async () => {
    const { usageStorage, dispatcher } = makeMocks();
    const svc = new ProbeService(dispatcher, usageStorage);

    await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'chat',
      source: 'background',
    });

    const saved = (usageStorage.saveRequest as any).mock.calls[0][0];
    expect(saved.attribution).toBe('background');
  });

  test('runProbe returns success result on dispatch success', async () => {
    const { usageStorage, dispatcher } = makeMocks();
    const svc = new ProbeService(dispatcher, usageStorage);

    const result = await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'chat',
      source: 'background',
    });

    expect(result.success).toBe(true);
    expect(result.apiType).toBe('chat');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('runProbe returns failure result and saves error on dispatch failure', async () => {
    const { usageStorage, dispatcher } = makeMocks();
    (dispatcher.dispatch as any).mockRejectedValueOnce(new Error('boom'));
    const svc = new ProbeService(dispatcher, usageStorage);

    const result = await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'chat',
      source: 'background',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    expect(usageStorage.saveError).toHaveBeenCalled();
    const saved = (usageStorage.saveRequest as any).mock.calls[0][0];
    expect(saved.responseStatus).toBe('error');
  });

  test('runProbe rejects transcriptions apiType', async () => {
    const { usageStorage, dispatcher } = makeMocks();
    const svc = new ProbeService(dispatcher, usageStorage);

    const result = await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'transcriptions' as any,
      source: 'manual',
    });

    expect(result.success).toBe(false);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  test('runProbe cancels streaming response to release concurrency slot', async () => {
    const cancelSpy = vi.fn(async () => {});
    const { usageStorage, dispatcher } = makeMocks();
    (dispatcher.dispatch as any).mockResolvedValueOnce({
      id: 'r',
      model: 'test-model',
      created: Date.now(),
      content: null,
      stream: { cancel: cancelSpy },
      usage: undefined,
      plexus: {
        provider: 'p1',
        model: 'm1',
        apiType: 'chat',
        canonicalModel: 'm1',
        attemptCount: 1,
      },
    });

    const svc = new ProbeService(dispatcher, usageStorage);
    const result = await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'chat',
      source: 'background',
    });

    expect(result.success).toBe(true);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test('runProbe skips cancellation when stream has no cancel method', async () => {
    const { usageStorage, dispatcher } = makeMocks();
    (dispatcher.dispatch as any).mockResolvedValueOnce({
      id: 'r',
      model: 'test-model',
      created: Date.now(),
      content: null,
      stream: {},
      usage: undefined,
      plexus: {
        provider: 'p1',
        model: 'm1',
        apiType: 'chat',
        canonicalModel: 'm1',
        attemptCount: 1,
      },
    });

    const svc = new ProbeService(dispatcher, usageStorage);
    const result = await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'chat',
      source: 'background',
    });

    expect(result.success).toBe(true);
  });

  test('runProbe swallows stream cancellation errors', async () => {
    const cancelSpy = vi.fn(async () => {
      throw new Error('stream already closed');
    });
    const { usageStorage, dispatcher } = makeMocks();
    (dispatcher.dispatch as any).mockResolvedValueOnce({
      id: 'r',
      model: 'test-model',
      created: Date.now(),
      content: null,
      stream: { cancel: cancelSpy },
      usage: undefined,
      plexus: {
        provider: 'p1',
        model: 'm1',
        apiType: 'chat',
        canonicalModel: 'm1',
        attemptCount: 1,
      },
    });

    const svc = new ProbeService(dispatcher, usageStorage);
    const result = await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'chat',
      source: 'background',
    });

    expect(result.success).toBe(true);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test('images probe sends only model/prompt/n so every image target accepts it', async () => {
    const { usageStorage, dispatcher } = makeMocks();
    (dispatcher.dispatchImageGenerations as any).mockResolvedValueOnce({
      created: Date.now(),
      data: [{ b64_json: 'aGk=' }],
      plexus: {
        provider: 'p1',
        model: 'm1',
        apiType: 'images',
        canonicalModel: 'm1',
        attemptCount: 1,
      },
    });

    const svc = new ProbeService(dispatcher, usageStorage);
    const result = await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'images',
      source: 'manual',
    });

    expect(dispatcher.dispatchImageGenerations).toHaveBeenCalledTimes(1);
    const dispatched = (dispatcher.dispatchImageGenerations as any).mock.calls[0][0];
    expect(dispatched.model).toBe('direct/p1/m1');
    expect(dispatched.prompt).toEqual(expect.any(String));
    expect(dispatched.n).toBe(1);
    // Codex Images rejects `response_format: 'url'` outright and does not
    // render 256x256, so the probe must not send either field.
    expect(dispatched).not.toHaveProperty('response_format');
    expect(dispatched).not.toHaveProperty('size');
    expect(Object.keys(dispatched.originalBody).sort()).toEqual(['model', 'n', 'prompt']);

    expect(result.success).toBe(true);
    expect(result.response).toBe('Success (1 image created)');
  });

  test('images probe reports how many images came back', async () => {
    const { usageStorage, dispatcher } = makeMocks();
    (dispatcher.dispatchImageGenerations as any).mockResolvedValueOnce({
      created: Date.now(),
      data: [{ b64_json: 'aGk=' }, { b64_json: 'aGk=' }],
      plexus: {
        provider: 'p1',
        model: 'm1',
        apiType: 'images',
        canonicalModel: 'm1',
        attemptCount: 1,
      },
    });

    const svc = new ProbeService(dispatcher, usageStorage);
    const result = await svc.runProbe({
      provider: 'p1',
      model: 'm1',
      apiType: 'images',
      source: 'manual',
    });

    expect(result.success).toBe(true);
    expect(result.response).toBe('Success (2 images created)');
  });
});
