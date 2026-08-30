export type MeterKind = 'balance' | 'allowance';

export type PeriodUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';

export type PeriodCycle = 'fixed' | 'rolling';

export type Utilization = number | 'unknown' | 'not_applicable';

export type MeterStatus = 'ok' | 'warning' | 'critical' | 'exhausted';

export interface Meter {
  // Identity
  key: string;
  label: string;
  group?: string;
  scope?: string;

  // Classification
  kind: MeterKind;
  unit: string;

  // Values
  limit?: number;
  used?: number;
  remaining?: number;
  utilizationPercent: Utilization;

  // Period (only for allowance)
  periodValue?: number;
  periodUnit?: PeriodUnit;
  periodCycle?: PeriodCycle;
  resetsAt?: string; // ISO-8601

  // Status
  status: MeterStatus;

  // Cooldown gating
  exhaustionThreshold?: number;
}

export interface MeterCheckResult {
  checkerId: string;
  checkerType: string;
  provider: string;
  /**
   * When the checker was bound to a specific provider key (per-key
   * checker, id `${provider}:key:${keyId}`), this carries the keyId
   * through. The QuotaScheduler uses it to target the per-key cooldown
   * slot on exhaustion so other keys on the same provider are
   * unaffected.
   */
  keyId?: string;
  checkedAt: string; // ISO-8601
  success: boolean;
  error?: string;
  meters: Meter[];
}
