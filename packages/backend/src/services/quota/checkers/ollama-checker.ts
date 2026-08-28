import { defineChecker } from '../checker-registry';
import { z } from 'zod';
import { logger } from '../../../utils/logger';

const USAGE_ENDPOINT = 'https://ollama.com/api/usage';
const ME_ENDPOINT = 'https://ollama.com/api/me';

interface OllamaUsageResponse {
  limits?: {
    session?: { usage?: number };
    weekly?: { usage?: number };
  };
}

interface OllamaMeResponse {
  Plan?: string;
}

function ratioPct(ratio: number): number {
  const r = Math.max(0, Math.min(1, ratio));
  return Math.round(r * 100);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Ollama Cloud quota tracker. Port of 9router's `getOllamaUsage`
 * (open-sse/services/usage/misc.js:37) into the Plexus `defineChecker`
 * shape. The API key is read from `options.apiKey` — injected by
 * `config-service.ts:602-606` from the stored provider-key record so the
 * user never has to paste a `__Secure-session` cookie.
 */
export default defineChecker({
  type: 'ollama',
  displayName: 'Ollama',
  optionsSchema: z.object({
    apiKey: z.string().trim().min(1, 'Ollama API key is required'),
    endpoint: z.string().url().optional(),
  }),
  async check(ctx) {
    const apiKey = ctx.requireOption<string>('apiKey').trim();
    const endpoint = ctx.getOption<string>('endpoint', USAGE_ENDPOINT);

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };

    logger.debug(`Calling ${endpoint}`);
    const usageResponse = await fetch(endpoint, { method: 'GET', headers });
    if (usageResponse.status === 401 || usageResponse.status === 403) {
      throw new Error('Ollama Cloud API key invalid or expired.');
    }
    if (!usageResponse.ok) {
      throw new Error(`Ollama Cloud usage API error (${usageResponse.status}).`);
    }

    let data: OllamaUsageResponse;
    try {
      data = (await usageResponse.json()) as OllamaUsageResponse;
    } catch {
      throw new Error('Ollama Cloud usage response was not JSON.');
    }

    // /api/me is best-effort — a failure here must not block quota tracking.
    let plan = 'Ollama Cloud';
    try {
      const meResponse = await fetch(ME_ENDPOINT, {
        method: 'POST',
        headers: { ...headers, 'Content-Length': '0' },
      });
      if (meResponse.ok) {
        const me = (await meResponse.json()) as OllamaMeResponse;
        if (typeof me?.Plan === 'string' && me.Plan.length > 0) {
          plan = capitalize(me.Plan);
        }
      }
    } catch {
      // swallow — keep the default plan label
    }

    const limits = data?.limits ?? {};
    const sessionRaw = limits.session?.usage;
    const weeklyRaw = limits.weekly?.usage;
    const meters = [];

    if (typeof sessionRaw === 'number' && Number.isFinite(sessionRaw)) {
      const used = ratioPct(sessionRaw);
      meters.push(
        ctx.allowance({
          key: 'session',
          label: 'Session usage',
          unit: 'percentage',
          used,
          remaining: 100 - used,
          periodValue: 5,
          periodUnit: 'hour',
          periodCycle: 'rolling',
        })
      );
    }
    if (typeof weeklyRaw === 'number' && Number.isFinite(weeklyRaw)) {
      const used = ratioPct(weeklyRaw);
      meters.push(
        ctx.allowance({
          key: 'weekly',
          label: 'Weekly usage',
          unit: 'percentage',
          used,
          remaining: 100 - used,
          periodValue: 7,
          periodUnit: 'day',
          periodCycle: 'rolling',
        })
      );
    }

    if (meters.length === 0) {
      throw new Error('No usage limits reported.');
    }

    logger.debug(`Ollama plan=${plan}, ${meters.length} meter(s)`);
    return meters;
  },
});
