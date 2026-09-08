import { describe, expect, test } from 'vitest';
import { ImageGenerationTransformerFactory } from '../dispatch/image-transformer-factory';

describe('ImageGenerationTransformerFactory', () => {
  test('resolves OpenAI Images targets', () => {
    expect(ImageGenerationTransformerFactory.getTransformer('openai-images').name).toBe('image');
    expect(ImageGenerationTransformerFactory.getTransformer('chat').name).toBe('image');
  });

  test('resolves native Gemini image targets', () => {
    expect(ImageGenerationTransformerFactory.getTransformer('gemini').name).toBe('gemini');
  });

  test('resolves the dedicated OpenRouter image target', () => {
    expect(ImageGenerationTransformerFactory.getTransformer('openrouter-images').name).toBe(
      'openrouter-images'
    );
  });

  test('rejects unsupported target protocols', () => {
    expect(() => ImageGenerationTransformerFactory.getTransformer('messages')).toThrow(
      'Unsupported image provider type'
    );
    expect(() => ImageGenerationTransformerFactory.getTransformer('images')).toThrow(
      'Unsupported image provider type'
    );
    expect(() => ImageGenerationTransformerFactory.getTransformer('openrouter')).toThrow(
      'Unsupported image provider type'
    );
  });
});
