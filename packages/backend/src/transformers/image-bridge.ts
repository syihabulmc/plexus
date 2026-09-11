import { Transformer } from '../types/transformer';
import { UnifiedChatRequest, UnifiedChatResponse } from '../types/unified';

/**
 * The `images` "provider transformer" — a deliberate NO-OP.
 *
 * It is not a wire protocol. It exists because the auto-bridge
 * (services/dispatch/image-model-bridge.ts) returns output that is ALREADY
 * unified, tagged `plexus.apiType = 'images'`, and the response handler
 * unconditionally resolves a provider transformer from that tag before
 * deciding what to do with the response.
 *
 * The one behaviour that matters here is an ABSENCE: this class deliberately
 * defines NO `transformStream`. The response handler only calls
 * `transformStream` when the transformer defines one, so leaving it out is
 * what lets the bridge's synthesized unified chunk stream flow straight into
 * the client formatter instead of being parsed as provider SSE bytes.
 *
 * The request-side methods throw: nothing is ever dispatched over an
 * `images` "wire", so reaching them means a routing bug, and failing loudly
 * beats silently sending a malformed request upstream.
 */
export class ImageBridgeTransformer implements Transformer {
  readonly name = 'images';
  /** Never dispatched — the bridge calls the image pipeline directly. */
  readonly defaultEndpoint = '';

  async parseRequest(_input: any): Promise<UnifiedChatRequest> {
    throw new Error("'images' is not a wire protocol: bridged image requests are never parsed.");
  }

  async transformRequest(_request: UnifiedChatRequest): Promise<any> {
    throw new Error(
      "'images' is not a wire protocol: bridged image requests are dispatched through the image pipeline."
    );
  }

  /** Identity: the bridge already produced unified output. */
  async transformResponse(response: any): Promise<UnifiedChatResponse> {
    return response as UnifiedChatResponse;
  }

  /** Identity: client-facing formatting is the client transformer's job. */
  async formatResponse(response: UnifiedChatResponse): Promise<any> {
    return response;
  }

  /**
   * No wire events to read usage from — the bridge puts usage directly on the
   * unified response and on the stream's finish chunk.
   */
  extractUsage(_eventData: string): undefined {
    return undefined;
  }
}
