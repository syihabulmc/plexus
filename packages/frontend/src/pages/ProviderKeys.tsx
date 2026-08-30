import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Upload, Combine } from 'lucide-react';
import { api, ProviderKey, Provider } from '../lib/api';
import { PageHeader } from '../components/layout/PageHeader';
import { PageContainer } from '../components/layout/PageContainer';
import { DataTable } from '../components/ui/DataTable';
import { Modal } from '../components/ui/Modal';
import { Switch } from '../components/ui/Switch';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Button } from '../components/ui/Button';
import { CopyButton } from '../components/ui/CopyButton';
import { useToast } from '../contexts/ToastContext';
import { selectionStats, toggleSelection } from '../lib/providerKeySelection';
import { groupDuplicateProviderKeys } from '../components/providers/consolidateKeys';
import { ConsolidateKeysModal } from '../components/providers/ConsolidateKeysModal';

/**
 * Per-provider API key management. Each key is a first-class identity
 * for routing, cooldowns, quota, and logs. See
 * docs/superpowers/specs/2026-08-30-provider-keys-design.md.
 */
export function ProviderKeys() {
  const { success, error } = useToast();
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderKey | null>(null);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [filterProviderId, setFilterProviderId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkProviderId, setBulkProviderId] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [bulkPriority, setBulkPriority] = useState<number | ''>('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [consolidateOpen, setConsolidateOpen] = useState(false);
  const [consolidating, setConsolidating] = useState(false);

  // Form state
  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [managementKey, setManagementKey] = useState('');
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState<number | ''>('');
  const [enabled, setEnabled] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const [keysRes, providersRes] = await Promise.all([
        api.getProviderKeys(),
        api.getProviders(),
      ]);
      setKeys(keysRes.keys);
      setProviders(providersRes);
      setSelected(new Set());
    } catch (e: any) {
      error(e?.message ?? 'Failed to load provider keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const idToSlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of providers) {
      if (p.id) map.set(p.id, p.name);
    }
    return map;
  }, [providers]);

  const providerOptions = useMemo(
    () => providers.map((p) => ({ value: p.id, label: p.name })),
    [providers]
  );

  const filteredKeys = useMemo(
    () => (filterProviderId ? keys.filter((k) => k.provider_id === filterProviderId) : keys),
    [keys, filterProviderId]
  );

  const { allSelected, someSelected } = selectionStats(
    selected,
    filteredKeys.map((k) => k.id)
  );

  const openAdd = () => {
    setEditing(null);
    setProviderId(providerOptions[0]?.value ?? '');
    setLabel('');
    setApiKey('');
    setManagementKey('');
    setNotes('');
    setPriority('');
    setEnabled(true);
    setModalOpen(true);
  };

  const openEdit = (row: ProviderKey) => {
    setEditing(row);
    setProviderId(row.provider_id);
    setLabel(row.label);
    setApiKey(row.api_key);
    setManagementKey(row.management_key ?? '');
    setNotes(row.notes ?? '');
    setPriority(row.priority);
    setEnabled(row.enabled);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
  };

  const handleSave = async () => {
    if (!providerId || !apiKey) {
      error('Provider and API key are required');
      return;
    }
    try {
      await api.saveProviderKey({
        id: editing?.id,
        provider_id: providerId,
        label: label.trim() || '',
        api_key: apiKey,
        management_key: managementKey || undefined,
        notes: notes || undefined,
        enabled,
        priority: priority === '' ? undefined : Number(priority),
      });
      success(editing ? 'Provider key updated' : 'Provider key created');
      closeModal();
      await loadData();
    } catch (e: any) {
      error(e?.message ?? 'Failed to save provider key');
    }
  };

  const handleDelete = async (row: ProviderKey) => {
    if (!window.confirm(`Delete key "${row.label}"? This cannot be undone.`)) return;
    setDeletingId(row.id);
    try {
      await api.deleteProviderKey(row.id);
      success('Provider key deleted');
      await loadData();
    } catch (e: any) {
      error(e?.message ?? 'Failed to delete key');
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleEnabled = async (row: ProviderKey) => {
    setTogglingId(row.id);
    try {
      await api.saveProviderKey({ ...row, id: row.id, enabled: !row.enabled });
      await loadData();
    } catch (e: any) {
      error(e?.message ?? 'Failed to toggle key');
    } finally {
      setTogglingId(null);
    }
  };

  const handleFilterChange = (id: string) => {
    setFilterProviderId(id);
    setSelected(new Set());
  };

  const handleBulkAdd = () => {
    setBulkProviderId(providerOptions[0]?.value ?? '');
    setBulkText('');
    setBulkPriority('');
    setBulkOpen(true);
  };

  const handleBulkSave = async () => {
    if (!bulkProviderId || !bulkText.trim()) {
      error('Provider and at least one `label:key` line are required');
      return;
    }
    setBulkLoading(true);
    try {
      const lines = bulkText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const keys = lines
        .map((line) => {
          const idx = line.indexOf(':');
          if (idx < 0) return null;
          const label = line.slice(0, idx).trim();
          const api_key = line.slice(idx + 1).trim();
          if (!api_key) return null;
          return { label, api_key };
        })
        .filter(Boolean) as Array<{ label: string; api_key: string }>;
      if (keys.length === 0) {
        error('No valid `label:key` lines found');
        return;
      }
      await api.saveProviderKeysBulk(
        bulkProviderId,
        keys.map((k, i) => ({
          ...k,
          priority: bulkPriority === '' ? undefined : Number(bulkPriority) + i,
        }))
      );
      success(`Added ${keys.length} key(s)`);
      setBulkOpen(false);
      await loadData();
    } catch (e: any) {
      error(e?.message ?? 'Failed to bulk-add keys');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleDeleteSelected = async () => {
    const ids = [...selected];
    if (!window.confirm(`Delete ${ids.length} selected key${ids.length > 1 ? 's' : ''}?`)) return;
    setBulkDeleting(true);
    try {
      // Use Promise.allSettled so a single failed delete doesn't
      // short-circuit the whole batch (matches the consolidate handler
      // below). Surface partial-failure counts in the toast.
      const results = await Promise.allSettled(ids.map((id) => api.deleteProviderKey(id)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      if (failed > 0) {
        error(`Deleted ${ok}, ${failed} failed`);
      } else {
        success(`Deleted ${ok} key(s)`);
      }
      setSelected(new Set());
      await loadData();
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleConsolidateConfirm = async (ids: string[]) => {
    setConsolidating(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => api.deleteProviderKey(id)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      if (failed > 0) {
        error(`Deleted ${ok}, ${failed} failed`);
      } else {
        success(`Consolidated ${ok} duplicate key(s)`);
      }
      await loadData();
    } finally {
      setConsolidating(false);
      setConsolidateOpen(false);
    }
  };

  const duplicateGroups = useMemo(
    () => groupDuplicateProviderKeys(keys, (id) => idToSlug.get(id) ?? null),
    [keys, idToSlug]
  );

  const columns = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected && !allSelected;
          }}
          onChange={() => {
            if (allSelected) {
              setSelected(new Set());
            } else {
              setSelected(new Set(filteredKeys.map((k) => k.id)));
            }
          }}
          className="h-3.5 w-3.5 accent-primary"
        />
      ),
      render: (row: ProviderKey) => (
        <input
          type="checkbox"
          aria-label={`Select key ${row.label}`}
          checked={selected.has(row.id)}
          onChange={() => setSelected((s) => toggleSelection(s, row.id))}
          className="h-3.5 w-3.5 accent-primary"
        />
      ),
    },
    {
      key: 'provider',
      header: 'Provider',
      render: (row: ProviderKey) => idToSlug.get(row.provider_id) ?? row.provider_id,
    },
    {
      key: 'label',
      header: 'Label',
      render: (row: ProviderKey) => (
        <span className="inline-flex items-center gap-1">
          {row.label || '—'}
          <CopyButton value={row.label} size="sm" />
        </span>
      ),
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (row: ProviderKey) =>
        row.notes ? (
          <span className="inline-flex items-center gap-1 text-xs">
            {row.notes.length > 12 ? `${row.notes.slice(0, 8)}...${row.notes.slice(-4)}` : row.notes}
            <CopyButton value={row.notes} size="sm" />
          </span>
        ) : (
          <span className="text-text-muted">—</span>
        ),
    },
    {
      key: 'api_key',
      header: 'API Key',
      render: (row: ProviderKey) => (
        <span className="inline-flex items-center gap-1 font-mono text-xs">
          {row.api_key.slice(0, 8)}...{row.api_key.slice(-4)}
          <CopyButton value={row.api_key} size="sm" />
        </span>
      ),
    },
    {
      key: 'management_key',
      header: 'Management Key',
      render: (row: ProviderKey) =>
        row.management_key ? (
          <span className="inline-flex items-center gap-1 font-mono text-xs">
            {row.management_key.slice(0, 8)}...{row.management_key.slice(-4)}
            <CopyButton value={row.management_key} size="sm" />
          </span>
        ) : (
          <span className="text-text-muted">—</span>
        ),
    },
    {
      key: 'enabled',
      header: 'Enabled',
      render: (row: ProviderKey) => (
        <Switch
          checked={row.enabled}
          disabled={togglingId === row.id}
          onChange={() => void handleToggleEnabled(row)}
        />
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      render: (row: ProviderKey) => row.priority,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (row: ProviderKey) => (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => openEdit(row)} aria-label="Edit">
            <Pencil size={14} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleDelete(row)}
            disabled={deletingId === row.id}
            aria-label="Delete"
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Provider Keys"
        subtitle="Per-provider API keys. Each key is treated as a first-class identity for routing, cooldowns, quota, and logs."
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Combine size={14} />}
              onClick={() => setConsolidateOpen(true)}
              disabled={keys.length === 0 || consolidating}
              title={
                duplicateGroups.length === 0
                  ? 'No duplicates'
                  : `${duplicateGroups.length} provider(s) with duplicates`
              }
            >
              Consolidate
            </Button>
            <Button size="sm" variant="secondary" leftIcon={<Upload size={14} />} onClick={handleBulkAdd}>
              Bulk Add
            </Button>
            <Button size="sm" leftIcon={<Plus size={14} />} onClick={openAdd}>
              Add Key
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Select
          label="Provider"
          value={filterProviderId}
          onChange={handleFilterChange}
          options={[{ value: '', label: 'All providers' }, ...providerOptions]}
          placeholder="All providers"
        />
        {selected.size > 0 && (
          <Button
            variant="danger"
            size="sm"
            onClick={handleDeleteSelected}
            disabled={bulkDeleting}
            leftIcon={<Trash2 size={14} />}
          >
            {bulkDeleting ? 'Deleting...' : `Delete selected (${selected.size})`}
          </Button>
        )}
      </div>

      <DataTable
        key={filterProviderId}
        columns={columns}
        data={filteredKeys}
        getRowKey={(row) => row.id}
        pageSize={10}
        emptyTitle="No provider keys"
        emptyDescription="Add a provider key to enable multi-key routing for a provider."
        loading={loading}
      />

      <Modal
        isOpen={modalOpen}
        onClose={closeModal}
        title={editing ? 'Edit Provider Key' : 'Add Provider Key'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeModal}>Cancel</Button>
            <Button onClick={handleSave}>{editing ? 'Save' : 'Create'}</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Select
            label="Provider"
            value={providerId}
            onChange={setProviderId}
            options={providerOptions}
            disabled={!!editing}
          />
          <Input
            label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. prod-key (auto-filled to a GUID if empty)"
          />
          <Input
            label="API Key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />
          <Input
            label="Management Key (optional)"
            type="password"
            value={managementKey}
            onChange={(e) => setManagementKey(e.target.value)}
            placeholder="Used by OpenRouter credit checks"
          />
          <Input
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Free-text annotation"
          />
          <Input
            label="Priority (optional, lower = first)"
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value === '' ? '' : Number(e.target.value))}
            placeholder="append to end if empty"
          />
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onChange={setEnabled} aria-label="Enabled" />
            <span className="text-xs">Enabled</span>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Bulk Add Keys"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setBulkOpen(false)} disabled={bulkLoading}>
              Cancel
            </Button>
            <Button onClick={handleBulkSave} disabled={bulkLoading}>
              {bulkLoading ? 'Adding…' : 'Add All'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Select
            label="Provider"
            value={bulkProviderId}
            onChange={setBulkProviderId}
            options={providerOptions}
          />
          <div>
            <label className="text-xs font-medium text-text-secondary">Lines (one per key, format `label:key`)</label>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={'prod-key-1:sk-abc...\nprod-key-2:sk-def...'}
              rows={6}
              className="mt-1 w-full rounded border border-border bg-bg-card p-2 font-mono text-xs"
            />
          </div>
          <Input
            label="Starting priority (optional, +1 per key)"
            type="number"
            value={bulkPriority}
            onChange={(e) => setBulkPriority(e.target.value === '' ? '' : Number(e.target.value))}
            placeholder="append to end if empty"
          />
        </div>
      </Modal>

      <ConsolidateKeysModal
        isOpen={consolidateOpen}
        groups={duplicateGroups}
        onCancel={() => setConsolidateOpen(false)}
        onConfirm={handleConsolidateConfirm}
      />
    </PageContainer>
  );
}
