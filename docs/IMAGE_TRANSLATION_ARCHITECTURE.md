# Image translation architecture

**Status:** buffered translation phase implemented; streaming and discovery remain deferred.

## Decision and scope

Use the dedicated [OpenRouter Image API request shape](https://openrouter.ai/docs/api/api-reference/images/generate-an-image)
as the inbound vocabulary, but make Plexus's image intermediate representation (IR) the internal
contract. OpenRouter compatibility is a boundary format, not an upstream dependency or the IR itself.

```text
OpenRouter-shaped JSON request
  -> ingress validation and normalization
  -> canonical Plexus image request IR
  -> Plexus candidate selection and admission
  -> target-specific OpenAI-compatible, OpenRouter, or Gemini image transformer
  -> upstream request
  -> target-specific response normalization
  -> canonical Plexus image response
  -> client-format response
```

The initial implementation covers buffered text-to-image and reference-image-conditioned generation
against configured OpenAI Images-compatible image endpoints, the dedicated OpenRouter `/images` endpoint, and native Gemini image-generating models. The configured target API types are `openai-images`, `openrouter-images`, and `gemini`.
Preserve the existing `/v1/images/generations` JSON and `/v1/images/edits` multipart compatibility
surfaces; they should converge on the same image IR rather than acquire separate provider pipelines.
“OpenRouter-shaped” means `model`, `prompt`, and image options, **not** chat `messages`/`modalities` or
Responses API `image_generation` tools. The supplied multimodal guide's chat-completions image path
and those existing chat/tool paths are outside this change.

Streaming, partial-image events, image-model discovery, and per-endpoint capability/pricing discovery
are deferred. Use existing provider/model configuration; do not add discovery endpoints or claim full
OpenRouter API parity. `stream: true` must receive an explicit unsupported-feature error in this phase,
not silently start a buffered request. Imagen `:predict`, additional native provider protocols, and
cross-provider mask/inpainting equivalence are not implied by this support.

## Canonical request IR

Normalize once at ingress; build a fresh target payload for every attempt. The IR contains:

- **Identity:** requested model/alias, prompt, request ID, and existing Plexus access/telemetry metadata.
- **Output intent:** count (`n`), resolution tier, aspect ratio, explicit dimensions, quality, output
  encoding, background, compression, and seed. Preserve legacy `size`, `style`, `user`, and
  `response_format` semantics at the compatibility boundary where applicable.
- **Inputs:** an ordered list of typed reference images, with MIME type and either a remote URL or
  decoded bytes; optional mask data remains distinct from an ordinary reference image.
- **Routing intent:** provider restrictions/order/fallback preference, separated from generation
  options and target-scoped provider options.

The OpenRouter vocabulary includes `resolution`, `aspect_ratio`, `size`, `quality`, `output_format`,
`background`, `output_compression`, `seed`, `n`, and `input_references`. Normalize a tier-valued `size`
into resolution intent; retain explicit pixel dimensions and reject conflicting size/resolution/ratio
inputs. Do not reinterpret output encoding (`png`, `jpeg`, `webp`, etc.) as delivery format
(`url` versus `b64_json`). Acceptance into the IR is not a promise that every model supports a value.

Transformers map only supported options. Required semantics such as reference images or masks must
never disappear silently; unsupported target/request combinations need an explicit error. Capability
limits belong to the target implementation/configuration until discovery exists. In particular, `n`
is an upper bound, not a reason to invent repeated upstream calls for a single-image model. Preserve
unset values so upstream defaults remain available.

## Provider preferences and target selection

Keep three decisions separate: selecting a Plexus provider/model, selecting its wire protocol, and
applying options understood by that target.

- `provider.only` restricts eligible **configured Plexus provider names**; `provider.ignore` excludes
  them. Neither creates providers nor bypasses alias membership, key policy, quotas, cooldowns, or
  concurrency limits. An empty eligible set is an error, not permission to ignore restrictions.
- `provider.order` ranks eligible providers; it is not an allowlist. Unlisted eligible providers remain
  fallback candidates. With no request preference, preserve configured Plexus routing behavior.
- `provider.allow_fallbacks: false` limits the request to its primary eligible target. `true` cannot
  override globally disabled failover, and does not make non-retryable errors retryable.
- `provider.sort` is a routing preference, not an image parameter. Any supported price/throughput/
  latency mapping must use meaningful Plexus ranking data; do not equate chat token throughput with
  image throughput. Reject unsupported sort forms rather than pretending to implement OpenRouter's
  full ranking behavior.
- `provider.options` is scoped by configured provider name. Only the selected target's supported
  options reach its transformer; never send another provider's options or the entire routing object
  to OpenAI/Gemini/OpenRouter. OpenRouter's external provider tags are not automatically Plexus provider names.
  Routing within an OpenRouter upstream, if configured, is a separate provider-specific concern.

Resolve the wire protocol from the selected target's model `access_via` and provider configuration,
not from the incoming JSON shape or a model-name substring. A Gemini target must use a Gemini image
transformer even though the ingress API is `images`. Follow the embeddings factory's dedicated-provider
pattern, while respecting model-level restrictions and configured URLs. Retain existing dispatch
admission, retry history, error handling, and observability rather than creating a second router.

## Reference images and target transforms

Inbound `input_references` entries use the OpenRouter form:

```json
{
  "type": "image_url",
  "image_url": { "url": "data:image/png;base64,..." }
}
```

HTTP(S) URLs are also accepted. Multipart image uploads become the same typed references. Preserve
reference order and actual MIME types; do not hardcode JPEG or flatten images into prompt text.
Resolve remote bytes only when the selected protocol requires them. Downloads are an external-input
boundary: enforce URL/redirect safety, timeouts, size limits, and accepted image content types without
forwarding provider credentials. Rebuild consumed multipart bodies per attempt; adapters may resolve a
remote reference again on a later failover attempt. Reference images are not masks, and a mask cannot
be dropped on Gemini.

| Target | Request mapping | Response mapping |
| --- | --- | --- |
| OpenAI-compatible images | JSON `/images/generations` for text-only input; multipart `/images/edits` when a single reference requires editing input. Map supported image options according to the target's capabilities. Use bearer auth and let multipart serialization set its boundary. | Normalize `data[]` URL/base64 items, revised prompts, and reported usage. |
| Dedicated OpenRouter images (`openrouter-images`) | `/images` relative to the configured OpenRouter API base. Rebuild the supported normalized fields and reference-image entries; do not forward the original body. Use bearer auth. | Normalize OpenRouter `data[]` and `usage` into the canonical image response. |
| Native Gemini images | `/v1beta/models/{model}:generateContent`, with prompt and reference `inlineData` parts in `contents`; request image output via `generationConfig.responseModalities` and map ratio/resolution to `imageConfig.aspectRatio`/`imageSize` where supported. Use Gemini authentication. | Extract generated image `inlineData` parts and their MIME types; normalize `usageMetadata`. Do not treat text-only or safety-blocked responses as successful image generation. |

Use image-specific OpenRouter and Gemini transformers. The existing chat builder is not an image capability layer,
and its response transformer currently extracts text/tool calls rather than generated image bytes.
Do not assume arbitrary HTTP URLs are valid Gemini file-service URIs.

Provider/model/alias `extraBody` remains a trusted configuration extension, not a replacement for
canonical fields or a way to mix wire formats. Preserve the existing generation precedence
(provider, then model, then alias overrides) when composing target-specific payloads, and document
unsupported multipart overrides rather than introducing accidental behavior.

## Canonical response and normalization

Return a single image response model: `created` (Unix seconds), ordered `data[]`, and optional usage.
Each image carries bytes/base64 or a usable URL, its actual `media_type` when known, and an optional
`revised_prompt`. Use one receipt timestamp when an upstream supplies no creation time. Preserve all
returned images; auxiliary Gemini text is not image data or a fabricated revised prompt.

Normalize OpenAI input/output token fields and Gemini `usageMetadata` to Plexus's internal usage
names. The OpenRouter-shaped formatter projects these to `prompt_tokens`, `completion_tokens`, and
`total_tokens`, with reported cost when available. Do not invent zero usage or cost when absent.

For the OpenRouter-shaped response, emit `b64_json` image bytes and `media_type`; materialize URL-only
upstream results through the same bounded fetch policy. Preserve legacy URL/base64 delivery when the
selected compatibility surface and target support it. Do not manufacture hosted URLs, mislabel bytes
as PNG, or promise transcoding. Keep raw provider responses and internal `plexus` routing/configuration
metadata out of the client payload. Record the actual upstream protocol and translation status rather
than unconditionally marking image requests as passthrough.

## File-level extension points

Paths below are relative to `packages/backend/src/` unless otherwise noted. New paths listed here
are part of the implemented buffered phase.

| File | Responsibility / implementation seam |
| --- | --- |
| `routes/inference/images.ts` | Ingress validation, OpenRouter-shaped parsing, compatibility multipart parsing, request context, and client response formatting for `/v1/images`, `/v1/images/generations`, and `/v1/images/edits`. The public incoming operation remains `images`; target protocol names are separate. |
| `routes/inference/index.ts` | Keep image entrypoints within the existing authenticated route registration. |
| `types/unified.ts` | Extend the current `UnifiedImageGeneration*` / `UnifiedImageEdit*` types into the canonical image contract, including references, output intent, MIME types, and normalized usage. |
| `transformers/image.ts` and `transformers/index.ts` | Current OpenAI-only parser/builder/formatter and exports; retain compatibility entrypoints while separating inbound normalization from target mapping. |
| **New:** `types/image-transformer.ts` | Image-specific endpoint/auth, request-body, and response-normalization contract; use `types/embeddings-transformer.ts` as precedent, not the chat streaming interface. |
| `transformers/image.ts`, **new:** `transformers/images/openrouter.ts`, `transformers/images/gemini.ts` | OpenAI-compatible, dedicated OpenRouter, and native Gemini target-specific JSON/multipart construction, option mapping, and response decoding. The existing file retains the legacy parser/edit compatibility surface. |
| **New:** `services/dispatch/image-transformer-factory.ts` | Select an image transformer per target; `embeddings-transformer-factory.ts` is the existing pattern. |
| `services/dispatch/dispatcher.ts` | Keep the existing `dispatchImageGenerations` / `dispatchImageEdits` facade and media-dispatch delegation. |
| `services/dispatch/media-dispatcher.ts` | Select target protocol and transformer per attempt, construct target-native requests, and preserve policy, admission, failover, and metadata handling. |
| `services/routing/router.ts`, `services/providers/provider-api-selection.ts` | Apply image routing preferences and protocol eligibility without conflating API name matching with image capability; resolve target-specific base URLs. |
| `transformers/gemini/part-mapper.ts`, `utils/usage-normalizer.ts` | Existing reference points for Gemini parts and usage. Reuse only semantics that preserve image MIME/data correctly. |
| `docs/openapi/paths/v1_images*.yaml`, `docs/openapi/components/schemas/Image*.yaml` (repository root) | Publish the buffered `/v1/images` and legacy image request/response contracts. |

### Implemented baseline

The buffered phase now accepts `/v1/images` plus the existing OpenAI-compatible image routes. Image
requests are normalized into the unified IR, provider preferences are applied before admission, image
capability filtering prevents explicitly text/embedding targets from being selected, and target API
selection chooses an OpenAI-compatible, dedicated OpenRouter, or native Gemini transformer per attempt. OpenAI-compatible
requests use JSON generation or multipart editing for a single reference; OpenRouter requests use `/images`; Gemini requests
use native `generateContent` with image response modalities and inline reference data. Responses and
usage are normalized at the image boundary, while streaming, image-model discovery, and additional
native provider protocols remain deferred.
