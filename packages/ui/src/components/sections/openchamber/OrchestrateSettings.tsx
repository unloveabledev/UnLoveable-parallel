import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { updateDesktopSettings } from '@/lib/persistence';

type SettingsResponse = {
  orchestrateBaseUrl?: unknown;
  orchestrateTokenPresent?: unknown;
};

const normalizeBaseUrl = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const OrchestrateSettings: React.FC = () => {
  const [baseUrl, setBaseUrl] = React.useState('');
  const [token, setToken] = React.useState('');
  const [tokenPresent, setTokenPresent] = React.useState(false);
  const [tokenDirty, setTokenDirty] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isTesting, setIsTesting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          return;
        }
        const data = (await response.json().catch(() => null)) as SettingsResponse | null;
        if (cancelled || !data) {
          return;
        }
        setBaseUrl(normalizeBaseUrl(data.orchestrateBaseUrl));
        setTokenPresent(Boolean(data.orchestrateTokenPresent));
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = React.useCallback(async () => {
    setIsSaving(true);
    try {
      const changes: Record<string, unknown> = {
        orchestrateBaseUrl: baseUrl.trim(),
      };
      if (tokenDirty) {
        changes.orchestrateToken = token;
      }
      await updateDesktopSettings(changes);
      setToken('');
      setTokenDirty(false);
      toast.success('Orchestrate settings saved');
    } catch {
      toast.error('Failed to save Orchestrate settings');
    } finally {
      setIsSaving(false);
    }
  }, [baseUrl, token, tokenDirty]);

  const handleClearToken = React.useCallback(() => {
    setToken('');
    setTokenDirty(true);
    setTokenPresent(false);
  }, []);

  const handleTestConnection = React.useCallback(async () => {
    setIsTesting(true);
    try {
      const response = await fetch('/api/orchestrate/health', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        toast.success('Connected to Orchestrate');
        return;
      }

      const body = (await response.json().catch(() => null)) as null | { error?: { message?: unknown } };
      const msg = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
      toast.error(`Orchestrate not reachable: ${msg}`);
    } catch {
      toast.error('Orchestrate not reachable');
    } finally {
      setIsTesting(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="typography-ui-header font-semibold text-foreground">Orchestrate</h3>
        <p className="typography-meta text-muted-foreground">
          Connect OpenChamber Auto Mode to an Orchestrate server. Requests are proxied through OpenChamber so your token
          is not attached to Orchestrate requests from the browser.
        </p>
      </div>

      <div className="space-y-2">
        <div className="space-y-1">
          <div className="typography-ui-label text-foreground">Base URL</div>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:8787"
            disabled={isLoading || isSaving}
            className="font-mono text-xs"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <div className="typography-ui-label text-foreground">Token</div>
            <div className="typography-micro text-muted-foreground">
              {tokenPresent ? 'Saved' : 'Not set'}
            </div>
          </div>
          <Input
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setTokenDirty(true);
            }}
            placeholder={tokenPresent ? '•••••••• (stored)' : 'Paste token'}
            type="password"
            disabled={isLoading || isSaving}
            className="font-mono text-xs"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={handleTestConnection}
          disabled={isLoading || isSaving || isTesting}
        >
          {isTesting ? 'Testing…' : 'Test Connection'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={handleClearToken}
          disabled={isLoading || isSaving}
        >
          Clear Token
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={isLoading || isSaving}
        >
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <div className="typography-micro text-muted-foreground">
        Tip: Auto Mode works without Orchestrate configured, but you will only be able to run Prompt Mode.
      </div>
    </div>
  );
};
