import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';

type AuthenticationContext = {
  id: number;
  simulationName: string;
  method: string;
  path: string;
  createdAt: string;
  contextStatus: 'available' | 'expired' | 'unavailable';
  expiresAt: string | null;
  hasAuthentication: boolean;
};

type Props = {
  selectedId: string;
  onChange: (id: string) => void;
  enabled: boolean;
  id: string;
};

function formatTimestamp(value: string | null): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function statusFor(context: AuthenticationContext): string {
  if (context.contextStatus === 'expired') return 'Expired';
  if (context.contextStatus === 'unavailable' || !context.hasAuthentication) return 'Unavailable';
  if (context.expiresAt && new Date(context.expiresAt).getTime() - Date.now() <= 2 * 60_000) return 'Expiring soon';
  return 'Available';
}

export function AuthContextSelector({ selectedId, onChange, enabled, id }: Props) {
  const query = useQuery({
    queryKey: ['/api/auth-contexts'],
    enabled,
    queryFn: () => customFetch<AuthenticationContext[]>('/api/auth-contexts'),
  });
  const contexts = query.data ?? [];
  const reusable = contexts.filter((context) => context.contextStatus === 'available' && context.hasAuthentication);
  const historical = contexts.filter((context) => !reusable.includes(context));
  const selected = reusable.find((context) => String(context.id) === selectedId);

  return <div className="space-y-2">
    <label htmlFor={id} className="block text-xs font-medium">Authentication context</label>
    {query.isLoading ? <p className="text-xs text-muted-foreground">Loading available authentication contexts…</p>
      : query.isError ? <p role="alert" className="text-xs text-destructive">Could not load authentication contexts.</p>
        : <select id={id} value={selectedId} onChange={(event) => onChange(event.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
          <option value="">Select an available authentication context</option>
          <optgroup label="Available">
            {reusable.slice(0, 50).map((context) => <option key={context.id} value={context.id}>
              {context.simulationName} · {context.method} {context.path} · captured {formatTimestamp(context.createdAt)}
            </option>)}
          </optgroup>
          {historical.length > 0 && <optgroup label="Expired or unavailable (not selectable)">
            {historical.slice(0, 20).map((context) => <option key={context.id} value={context.id} disabled>
              {context.simulationName} · {context.method} {context.path} · {statusFor(context)}
            </option>)}
          </optgroup>}
        </select>}
    {selected && <div className="rounded-md border border-border bg-secondary/30 px-3 py-2.5 text-xs">
      <p className="font-medium">{selected.simulationName} session <span className="text-primary">· {statusFor(selected)}</span></p>
      <p className="mt-1 font-mono text-muted-foreground">{selected.method} {selected.path}</p>
      <p className="mt-1 text-muted-foreground">Captured: {formatTimestamp(selected.createdAt)} · Expires: {formatTimestamp(selected.expiresAt)}</p>
    </div>}
    <p className="text-xs leading-5 text-muted-foreground">Cookies and authorization values stay encrypted and are never displayed.</p>
  </div>;
}
