import React from 'react';
import { Input } from '../ui/Input';

export interface OllamaQuotaConfigProps {
  options: Record<string, unknown>;
  onChange: (options: Record<string, unknown>) => void;
}

export const OllamaQuotaConfig: React.FC<OllamaQuotaConfigProps> = ({ options, onChange }) => {
  const handleChange = (key: string, value: string) => {
    onChange({ ...options, [key]: value });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1">
        <label className="font-body text-[13px] font-medium text-text-secondary">
          API Key <span className="text-danger">*</span>
        </label>
        <Input
          type="password"
          value={(options.apiKey as string) ?? ''}
          onChange={(e) => handleChange('apiKey', e.target.value)}
          placeholder="Enter your Ollama Cloud API key"
        />
        <span className="text-[10px] text-text-muted">
          Required. Generate one from your Ollama Cloud dashboard.
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="font-body text-[13px] font-medium text-text-secondary">
          Endpoint (optional)
        </label>
        <Input
          value={(options.endpoint as string) ?? ''}
          onChange={(e) => handleChange('endpoint', e.target.value)}
          placeholder="https://ollama.com/api/usage"
        />
        <span className="text-[10px] text-text-muted">
          Custom usage endpoint URL. Defaults to Ollama Cloud&apos;s API.
        </span>
      </div>
    </div>
  );
};
