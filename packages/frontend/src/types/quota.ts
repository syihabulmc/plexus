export type MeterKind = 'balance' | 'allowance';
export type MeterStatus = 'ok' | 'warning' | 'critical' | 'exhausted';
export type Utilization = number | 'unknown' | 'not_applicable';

export interface Meter {
  key: string;
  label: string;
  kind: MeterKind;
  unit: string;
  limit?: number;
  used?: number;
  remaining?: number;
  utilizationPercent: Utilization;
  status: MeterStatus;
  periodValue?: number;
  periodUnit?: string;
  periodCycle?: string;
  resetsAt?: string;
  group?: string;
  scope?: string;
}

export interface QuotaCheckerInfo {
  checkerId: string;
  checkerType?: string;
  provider?: string;
  // Per-key identity for quota checkers bound to a specific provider
  // key (multi-key providers). The Quotas UI renders these as
  // "Provider - Label" so the user can tell per-key rows apart.
  keyId?: string;
  keyLabel?: string;
  checkedAt?: string;
  success: boolean;
  error?: string;
  meters: Meter[];
  oauthAccountId?: string;
  oauthProvider?: string;
}

export interface QuotaWindow {
  windowLabel?: string;
  used?: number;
  limit?: number;
  status?: MeterStatus;
  unit?: string;
  utilizationPercent?: Utilization;
}

export interface QuotaCheckResult {
  success: boolean;
  error?: string;
  windows?: QuotaWindow[];
}
