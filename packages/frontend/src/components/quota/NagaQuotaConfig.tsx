import React from 'react';
import { Input } from '../ui/Input';

export interface NagaQuotaConfigProps {
  options: Record<string, unknown>;
  onChange: (options: Record<string, unknown>) => void;
}

export const NagaQuotaConfig: React.FC<NagaQuotaConfigProps> = ({ options, onChange }) => {
  const handleChange = (key: string, value: string) => {
    onChange({ ...options, [key]: value || undefined });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label className="font-body text-[13px] font-medium text-text-secondary">
          Management Key
        </label>
        <Input
          type="password"
          value={(options.managementKey as string) ?? ''}
          onChange={(e) => handleChange('managementKey', e.target.value)}
          placeholder="Enter your TokenRouter management key"
        />
        <span className="text-[10px] text-text-muted">
          When present, the wallet balance endpoint is used (top-up + bonus meters).
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="font-body text-[13px] font-medium text-text-secondary">API Key</label>
        <Input
          type="password"
          value={(options.apiKey as string) ?? ''}
          onChange={(e) => handleChange('apiKey', e.target.value)}
          placeholder="Enter your TokenRouter API key"
        />
        <span className="text-[10px] text-text-muted">
          Used when no management key is set (subscription + usage endpoints).
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="font-body text-[13px] font-medium text-text-secondary">
          Endpoint (optional)
        </label>
        <Input
          value={(options.endpoint as string) ?? ''}
          onChange={(e) => handleChange('endpoint', e.target.value)}
          placeholder="https://api.tokenrouter.com"
        />
        <span className="text-[10px] text-text-muted">
          Custom API base URL. Defaults to the TokenRouter API.
        </span>
      </div>
    </div>
  );
};
