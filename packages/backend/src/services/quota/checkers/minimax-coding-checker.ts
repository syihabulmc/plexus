import { defineChecker, createMeterContext } from '../checker-registry';
import { z } from 'zod';
import type { Meter } from '../../../types/meter';

interface MiniMaxCodingModelRemain {
  start_time: number;
  end_time: number;
  remains_time?: number;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  current_interval_remaining_percent?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  current_weekly_remaining_percent?: number;
  weekly_remains_time?: number;
  weekly_end_time?: number;
  model_name: string;
}

interface MiniMaxCodingResponse {
  model_remains?: MiniMaxCodingModelRemain[];
  base_resp?: { status_code: number; status_msg?: string };
}

/** 9router: "MiniMax-M*" / "general" → "M-series"; else title-case names. */
function formatModelName(model: string): string {
  if (/^MiniMax-M\d*$/.test(model) || model === 'general') return 'M-series';
  return model
    .replace(/[_-]+/g, ' ')
    .replace(/\bTo\b/g, 'to')
    .replace(/\bTts\b/g, 'TTS')
    .replace(/\bHd\b/g, 'HD')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

function totalOf(
  model: MiniMaxCodingModelRemain,
  field: keyof MiniMaxCodingModelRemain
): number {
  return Math.max(0, Number(model[field]) || 0);
}

function percentOf(
  model: MiniMaxCodingModelRemain,
  field: keyof MiniMaxCodingModelRemain
): number | null {
  const v = model[field];
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * remains_time is a RELATIVE duration in ms until reset — must be added to the
 * capture time. Falls back to the absolute end_time (epoch ms).
 */
function resetsAtOf(
  model: MiniMaxCodingModelRemain,
  capturedAtMs: number,
  remainsField: keyof MiniMaxCodingModelRemain,
  endField: keyof MiniMaxCodingModelRemain
): string | undefined {
  const remainsMs = Number(model[remainsField]) || 0;
  if (remainsMs > 0) return new Date(capturedAtMs + remainsMs).toISOString();
  const end = Number(model[endField]);
  if (end > 0) return new Date(end < 1e12 ? end * 1000 : end).toISOString();
  return undefined;
}

/**
 * Port of 9router addMiniMaxQuota: emits one allowance meter per model per
 * window. When counts are absent (M-series percent-only buckets) normalize to
 * total=100 with a synthetic count matching the countMeansRemaining semantics.
 */
function addMiniMaxQuota(
  ctx: ReturnType<typeof createMeterContext>,
  meters: Meter[],
  key: string,
  label: string,
  model: MiniMaxCodingModelRemain,
  getTotal: (m: MiniMaxCodingModelRemain) => number,
  countField: keyof MiniMaxCodingModelRemain,
  percentField: keyof MiniMaxCodingModelRemain,
  remainsField: keyof MiniMaxCodingModelRemain,
  endField: keyof MiniMaxCodingModelRemain,
  countMeansRemaining: boolean,
  capturedAtMs: number,
  periodValue: number,
  periodUnit: 'hour' | 'week'
): void {
  const providedPercent = percentOf(model, percentField);
  const total = getTotal(model);
  if (total <= 0 && providedPercent === null) return;

  let effectiveTotal = total;
  let count = Math.max(0, Number(model[countField]) || 0);
  if (total <= 0 && providedPercent !== null) {
    effectiveTotal = 100;
    count = countMeansRemaining
      ? Math.round(effectiveTotal * (providedPercent / 100))
      : Math.round(effectiveTotal * (1 - providedPercent / 100));
  }

  // API field is misleading: on the coding_plan endpoint "usage_count" is
  // actually REMAINING, not used.
  const used = countMeansRemaining
    ? Math.max(effectiveTotal - count, 0)
    : Math.min(Math.max(0, count), effectiveTotal);
  const remaining = Math.max(effectiveTotal - used, 0);

  meters.push(
    ctx.allowance({
      key,
      label,
      unit: 'requests',
      limit: effectiveTotal,
      used,
      remaining,
      periodValue,
      periodUnit,
      periodCycle: 'rolling',
      resetsAt: resetsAtOf(model, capturedAtMs, remainsField, endField),
    })
  );
}

export default defineChecker({
  type: 'minimax-coding',
  displayName: 'MiniMax Coding',
  optionsSchema: z.object({
    apiKey: z.string().min(1, 'MiniMax Coding API key is required'),
    endpoint: z.string().url().optional(),
  }),
  async check(ctx) {
    const apiKey = ctx.requireOption<string>('apiKey');
    const endpoint = ctx.getOption<string>(
      'endpoint',
      'https://www.minimax.io/v1/api/openplatform/coding_plan/remains'
    );

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const data: MiniMaxCodingResponse = await response.json();
    if (data.base_resp?.status_code !== 0) {
      throw new Error(`MiniMax API error: ${data.base_resp?.status_msg || 'unknown error'}`);
    }

    // On the coding_plan endpoint the *_usage_count fields are REMAINING counts.
    const countMeansRemaining = endpoint.includes('/coding_plan/remains');
    const capturedAtMs = Date.now();
    const meters: Meter[] = [];

    for (const model of data.model_remains ?? []) {
      const modelLabel = formatModelName(model.model_name || 'Unknown');
      // Rolling 5h interval window
      addMiniMaxQuota(
        ctx,
        meters,
        `coding_plan:5h:${modelLabel}`,
        `${modelLabel} (5h)`,
        model,
        (m) => totalOf(m, 'current_interval_total_count'),
        'current_interval_usage_count',
        'current_interval_remaining_percent',
        'remains_time',
        'end_time',
        countMeansRemaining,
        capturedAtMs,
        5,
        'hour'
      );
      // Rolling 7d weekly window
      addMiniMaxQuota(
        ctx,
        meters,
        `coding_plan:7d:${modelLabel}`,
        `${modelLabel} (7d)`,
        model,
        (m) => totalOf(m, 'current_weekly_total_count'),
        'current_weekly_usage_count',
        'current_weekly_remaining_percent',
        'weekly_remains_time',
        'weekly_end_time',
        countMeansRemaining,
        capturedAtMs,
        1,
        'week'
      );
    }

    return meters;
  },
});
