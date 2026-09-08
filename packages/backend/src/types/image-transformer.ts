import type { UnifiedImageGenerationRequest, UnifiedImageGenerationResponse } from './unified';

/**
 * Target-protocol transformer for buffered image generation.
 *
 * The inbound image API is normalized into the unified image request before a
 * target transformer builds a provider-native request. Responses make the
 * reverse trip through the same target-specific boundary.
 */
export interface ImageGenerationTransformer {
  readonly name: string;
  readonly defaultEndpoint: string;

  getEndpoint(request: UnifiedImageGenerationRequest): string;

  getAuthHeaders?(apiKey: string, headers: Record<string, string>): void;

  transformGenerationRequest(request: UnifiedImageGenerationRequest): Promise<any>;

  transformGenerationResponse(
    response: any,
    request?: UnifiedImageGenerationRequest
  ): Promise<UnifiedImageGenerationResponse>;
}
