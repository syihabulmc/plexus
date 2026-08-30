import { defineChecker } from '../checker-registry';
import { z } from 'zod';
import { logger } from '../../../utils/logger';

interface OpenRouterCreditsResponse {
  data: {
    total_credits: number;
    total_usage: number;
  };
}

export default defineChecker({
  type: 'openrouter',
  displayName: 'OpenRouter',
  optionsSchema: z.object({
    // Per-key checkers inject `apiKey` (the key's own OpenRouter API key)
    // and, when present, `managementKey` (OpenRouter's separate management
    // key for credit balance checks). Prefer managementKey when the config
    // service injected it, so each per-key checker hits OpenRouter's
    // /api/v1/credits with the right credential.
    apiKey: z.string().min(1, 'OpenRouter API key is required'),
    managementKey: z.string().min(1).optional(),
    endpoint: z.string().url().optional(),
  }),
  async check(ctx) {
    // Prefer the key's managementKey (injected by buildProviderQuotaConfigs
    // for per-key checkers); fall back to the apiKey on the legacy path.
    const managementKey = ctx.getOption<string | undefined>('managementKey', undefined);
    const apiKey =
      (managementKey && managementKey.length > 0 ? managementKey : undefined) ??
      ctx.requireOption<string>('apiKey');
    const endpoint = ctx.getOption<string>('endpoint', 'https://openrouter.ai/api/v1/credits');

    logger.silly(`Calling ${endpoint}`);
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const data: OpenRouterCreditsResponse = await response.json();
    const { total_credits, total_usage } = data.data;
    const remaining = total_credits - total_usage;

    return [
      ctx.balance({
        key: 'balance',
        label: 'Account credits',
        unit: 'usd',
        limit: total_credits,
        used: total_usage,
        remaining,
      }),
    ];
  },
});
