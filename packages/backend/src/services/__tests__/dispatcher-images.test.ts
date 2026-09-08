import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Dispatcher } from '../dispatch/dispatcher';
import { setConfigForTesting } from '../../config';
import type { UnifiedImageGenerationRequest } from '../../types/unified';
import { CooldownManager } from '../runtime/cooldown-manager';

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

function baseConfig(providerId: string, provider: any, model: string) {
  return {
    providers: { [providerId]: provider },
    models: {
      image_alias: {
        selector: 'in_order',
        type: 'image',
        targets: [{ provider: providerId, model }],
      },
    },
    keys: {},
    failover: {
      enabled: true,
      retryableStatusCodes: [429, 500, 502, 503, 504],
      retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'],
    },
    quotas: [],
  } as any;
}

const request: UnifiedImageGenerationRequest = {
  model: 'image_alias',
  prompt: 'A watercolor fox',
  resolution: '2K',
  aspect_ratio: '16:9',
  input_references: [
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AA==' },
    },
  ],
  incomingApiType: 'images',
  requestId: 'image-request',
};

describe('Dispatcher image translation', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    await CooldownManager.getInstance().clearCooldown();
  });

  afterEach(async () => {
    await CooldownManager.getInstance().clearCooldown();
  });

  test('translates the unified request to an OpenAI-compatible edit payload', async () => {
    setConfigForTesting(
      baseConfig(
        'openai',
        {
          api_base_url: 'https://api.example.com/v1',
          api_key: 'openai-key',
          models: {
            'gpt-image': {
              type: 'image',
              access_via: ['openai-images'],
            },
          },
        },
        'gpt-image'
      )
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: 'AA==' }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const response = await new Dispatcher().dispatchImageGenerations(request);

    expect(response.data).toEqual([{ b64_json: 'AA==' }]);
    expect(response.plexus?.targetApiType).toBe('openai-images');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/images/edits');
    expect(options.headers.Authorization).toBe('Bearer openai-key');
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('prompt')).toBe('A watercolor fox');
    expect(options.body.get('size')).toBe('1792x1024');
  });

  test('prefers the dedicated OpenAI Images base URL over chat', async () => {
    setConfigForTesting(
      baseConfig(
        'openai',
        {
          api_base_url: {
            chat: 'https://chat.example.com/v1',
            'openai-images': 'https://images.example.com/v1',
          },
          api_key: 'openai-key',
          models: {
            'gpt-image': {
              type: 'image',
              access_via: ['chat'],
            },
          },
        },
        'gpt-image'
      )
    );
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'AA==' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await new Dispatcher().dispatchImageGenerations({
      ...request,
      input_references: undefined,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://images.example.com/v1/images/generations');
  });

  test('does not let client provider options override the routed model', async () => {
    setConfigForTesting(
      baseConfig(
        'openai',
        {
          api_base_url: 'https://api.example.com/v1',
          api_key: 'openai-key',
          models: {
            'gpt-image': {
              type: 'image',
              access_via: ['openai-images'],
            },
          },
        },
        'gpt-image'
      )
    );
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ created: 1, data: [{ b64_json: 'AA==' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await new Dispatcher().dispatchImageGenerations({
      ...request,
      input_references: undefined,
      provider: {
        options: {
          openai: {
            model: 'attacker-model',
            prompt: 'attacker-prompt',
            response_format: 'url',
            provider_specific_option: 'preserved',
          },
        },
      },
    });

    const [, options] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(options.body)).toEqual({
      model: 'gpt-image',
      prompt: 'A watercolor fox',
      size: '1792x1024',
      provider_specific_option: 'preserved',
    });
  });

  test('translates the unified request to the dedicated OpenRouter image endpoint', async () => {
    setConfigForTesting(
      baseConfig(
        'openrouter',
        {
          api_base_url: 'https://openrouter.ai/api/v1',
          api_key: 'openrouter-key',
          models: {
            'openrouter-image': {
              type: 'image',
              access_via: ['openrouter-images'],
            },
          },
        },
        'openrouter-image'
      )
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: 'AA==' }],
          usage: { prompt_tokens: 0, completion_tokens: 10, total_tokens: 10, cost: 0.04 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const response = await new Dispatcher().dispatchImageGenerations({
      ...request,
      input_references: undefined,
    });

    expect(response.data).toEqual([{ b64_json: 'AA==' }]);
    expect(response.plexus?.targetApiType).toBe('openrouter-images');
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect(options.headers.Authorization).toBe('Bearer openrouter-key');
    expect(JSON.parse(options.body)).toEqual({
      model: 'openrouter-image',
      prompt: 'A watercolor fox',
      resolution: '2K',
      aspect_ratio: '16:9',
    });
  });

  test('translates the unified request to native Gemini generateContent', async () => {
    setConfigForTesting(
      baseConfig(
        'google',
        {
          api_base_url: 'https://generativelanguage.googleapis.com',
          api_key: 'google-key',
          models: {
            'gemini-image': {
              type: 'image',
              access_via: ['gemini'],
            },
          },
        },
        'gemini-image'
      )
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const response = await new Dispatcher().dispatchImageGenerations(request);

    expect(response.data).toEqual([{ b64_json: 'AA==', media_type: 'image/png' }]);
    expect(response.plexus?.targetApiType).toBe('gemini');
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-image:generateContent'
    );
    expect(options.headers['x-goog-api-key']).toBe('google-key');
    const payload = JSON.parse(options.body);
    expect(payload.generationConfig).toMatchObject({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
    });
    expect(payload.contents[0].parts[1].inlineData).toEqual({
      mimeType: 'image/png',
      data: 'AA==',
    });
  });
});
