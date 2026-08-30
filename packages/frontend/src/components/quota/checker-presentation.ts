export function getCheckerDisplayName(
  checkerType: string | undefined,
  checkerId: string,
  displayNameMap?: Map<string, string>
): string {
  if (checkerType && displayNameMap?.has(checkerType)) return displayNameMap.get(checkerType)!;
  if (checkerType) return checkerType;
  return checkerId;
}

/**
 * Render a per-key quota checker as "Provider - Label" so the row is
 * recognisable in the Quotas UI. Falls back to the checkerId only when
 * the identity fields are missing (single-key legacy checker, or a
 * checker whose QuotaConfig predates the keyLabel propagation).
 */
export function getCheckerIdentityLabel(quota: {
  provider?: string;
  keyLabel?: string;
  keyId?: string;
  checkerId: string;
}): string {
  const provider = quota.provider;
  if (provider && quota.keyLabel) {
    return `${provider} - ${quota.keyLabel}`;
  }
  if (provider && quota.keyId) {
    return `${provider} - ${quota.keyId}`;
  }
  return quota.checkerId;
}
