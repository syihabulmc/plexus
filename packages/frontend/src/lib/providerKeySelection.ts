/**
 * Selection-set helpers for the Provider Keys page's bulk-select UI.
 * Pure data — no React, no UI. Test-friendly.
 */

export function toggleSelection(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectionFromIds(ids: string[]): Set<string> {
  return new Set(ids);
}

export function selectionStats(
  selected: Set<string>,
  ids: string[]
): { allSelected: boolean; someSelected: boolean } {
  const count = ids.filter((id) => selected.has(id)).length;
  return {
    allSelected: ids.length > 0 && count === ids.length,
    someSelected: count > 0 && count < ids.length,
  };
}
