import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { CopyButton } from '../ui/CopyButton';
import { Button } from '../ui/Button';
import { Trash2 } from 'lucide-react';
import type { DuplicateGroup } from './consolidateKeys';

interface ConsolidateKeysModalProps {
  isOpen: boolean;
  groups: DuplicateGroup[];
  onCancel: () => void;
  onConfirm: (idsToDelete: string[]) => void | Promise<void>;
}

/**
 * Modal that asks the user to pick which row to keep per duplicate
 * group, then deletes the rest. The picked row's id is excluded from
 * the delete list; all other row ids in the group are sent to
 * onConfirm.
 */
export function ConsolidateKeysModal({
  isOpen,
  groups,
  onCancel,
  onConfirm,
}: ConsolidateKeysModalProps) {
  // Default selection: keep the first row of each group. Initialize once
  // when the modal opens; do NOT re-initialize when `groups` changes (e.g.
  // after a refresh) so the user's "keep this row" choice persists across
  // data reloads. The "Reset to default" button below lets the user
  // re-pick the first row if desired.
  const [keepIds, setKeepIds] = useState<Record<string, string>>({});
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setInitialized(false);
      return;
    }
    if (initialized) return;
    const initial: Record<string, string> = {};
    for (const g of groups) {
      if (g.rows[0]) {
        initial[`${g.providerId}::${g.apiKeyNormalized}`] = g.rows[0].id;
      }
    }
    setKeepIds(initial);
    setInitialized(true);
  }, [isOpen, initialized, groups]);

  if (!isOpen) return null;

  const totalToDelete = groups.reduce(
    (acc, g) => acc + Math.max(0, g.rows.length - 1),
    0
  );

  const handleConfirm = async () => {
    const idsToDelete: string[] = [];
    for (const g of groups) {
      const keep = keepIds[`${g.providerId}::${g.apiKeyNormalized}`];
      for (const r of g.rows) {
        if (r.id !== keep) idsToDelete.push(r.id);
      }
    }
    await onConfirm(idsToDelete);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Consolidate Duplicate Keys"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            leftIcon={<Trash2 size={14} />}
          >
            {`Delete ${totalToDelete} key(s)`}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-text-secondary">
          {groups.length} duplicate group(s) found. Pick one row to keep per
          group; the others will be deleted.
        </p>
        {groups.map((g) => {
          const groupKey = `${g.providerId}::${g.apiKeyNormalized}`;
          const keep = keepIds[groupKey] ?? g.rows[0]?.id;
          return (
            <div key={groupKey} className="rounded border border-border bg-bg-card p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text">
                <span>Provider:</span>
                <span className="font-mono text-primary">{g.providerSlug ?? g.providerId}</span>
                <span className="text-text-muted">({g.rows.length} duplicates)</span>
              </div>
              <div className="space-y-1.5">
                {g.rows.map((r) => {
                  const selected = keep === r.id;
                  return (
                    <label
                      key={r.id}
                      className={`flex cursor-pointer items-center gap-2 rounded p-1.5 text-xs ${
                        selected ? 'bg-primary/10' : 'hover:bg-bg-subtle'
                      }`}
                    >
                      <input
                        type="radio"
                        name={groupKey}
                        checked={selected}
                        onChange={() => setKeepIds((m) => ({ ...m, [groupKey]: r.id }))}
                      />
                      <span className="flex-1">
                        <span className="font-medium">{r.label || '(no label)'}</span>
                        {r.notes && <span className="ml-2 text-text-muted">— {r.notes}</span>}
                      </span>
                      <span className="font-mono text-text-muted">
                        {String(r.api_key).slice(0, 8)}...{String(r.api_key).slice(-4)}
                      </span>
                      <CopyButton value={r.api_key} size="sm" />
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
