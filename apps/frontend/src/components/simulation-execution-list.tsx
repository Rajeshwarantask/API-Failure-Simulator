import { Check, ChevronRight, Clock3, History, Play, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';

type Execution = any;

export function SimulationExecutionList({
  executions,
  formatDate,
  onRun,
}: {
  executions: Execution[];
  formatDate: (value?: string | null) => string;
  onRun: () => void;
}) {
  return (
    <section className="surface-panel flex min-w-0 flex-col rounded-xl border border-border bg-card shadow-sm min-h-[24rem] max-h-[60vh] lg:absolute lg:inset-0 lg:h-full lg:max-h-none lg:min-h-0">
      <div className="panel-title flex items-center justify-between px-5 py-3.5">
        <div className="flex items-center gap-2.5"><History size={14} className="text-primary" /><h2>Recent executions</h2></div>
        <div className="eyebrow text-muted-foreground">{executions.length} latest</div>
      </div>
      {executions.length === 0 ? (
        <div className="px-6 py-14 text-center">
          <History size={22} className="mx-auto text-muted-foreground/50" />
          <h3 className="mt-3 text-sm font-semibold">No runs recorded</h3>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">Run this simulation to see the decision timeline.</p>
          <div className="mt-4"><Button onClick={onRun} data-testid="button-empty-run"><Play size={13} /> Run simulation</Button></div>
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain scroll-smooth scrollbar-thin" data-testid="simulation-executions-scroll">
          <div className="w-max min-w-full divide-y divide-border">
            {executions.map((execution) => <SimulationRunRow key={execution.id} execution={execution} formatDate={formatDate} />)}
          </div>
        </div>
      )}
    </section>
  );
}

function SimulationRunRow({ execution, formatDate }: { execution: Execution; formatDate: (value?: string | null) => string }) {
  const statusCode = typeof execution.simulatedStatus === 'number' ? execution.simulatedStatus : Number(execution.simulatedStatus);
  const statusTone = Number.isFinite(statusCode) && statusCode >= 200 && statusCode < 300 ? 'success' : Number.isFinite(statusCode) && statusCode >= 400 ? 'failure' : execution.status === 'timeout' ? 'timeout' : execution.status === 'success' ? 'success' : 'failure';
  const statusClasses = statusTone === 'success' ? 'border-[hsl(var(--chart-5)/.3)] bg-[hsl(var(--chart-5)/.1)] text-[hsl(var(--chart-5))]' : statusTone === 'timeout' ? 'border-accent/35 bg-accent/10 text-accent-foreground' : 'border-destructive/30 bg-destructive/10 text-destructive';
  const statusTextClass = statusTone === 'success' ? 'text-[hsl(var(--chart-5))]' : statusTone === 'timeout' ? 'text-accent-foreground' : 'text-destructive';

  return (
    <Link href={`/executions/${execution.id}`} data-testid={`link-execution-${execution.id}`} className="group flex w-full items-stretch gap-4 pl-5 hover:bg-secondary focus-visible:bg-secondary">
      <span className={`my-4 flex size-7 shrink-0 items-center justify-center self-center rounded-lg border ${statusClasses}`}>{statusTone === 'success' ? <Check size={14} /> : statusTone === 'timeout' ? <Clock3 size={14} /> : <X size={14} />}</span>
      <span className="min-w-0 flex-1 self-center overflow-hidden py-4"><span className="flex min-w-0 items-center gap-2"><span className="mono-data shrink-0 text-[11px] font-semibold">{execution.method}</span><span title={execution.url} className="min-w-0 whitespace-nowrap truncate font-mono text-xs text-muted-foreground">{execution.url}</span></span><span className="mt-1 block text-[11px] text-muted-foreground">{formatDate(execution.createdAt)} <span className="mx-1 text-border">/</span> {execution.failureType === 'none' ? 'pass-through' : execution.failureType.replaceAll('_', ' ')} <span className="mx-1 text-border">/</span> <span className="font-semibold text-foreground/70">{execution.source === 'external' ? 'external app' : 'dashboard run'}</span></span></span>
      <span className="sticky right-0 z-10 ml-auto flex flex-[0_0_126px] items-center justify-between gap-2 border-l border-border bg-card py-2 pl-3 pr-4 text-right shadow-[-6px_0_10px_-10px_rgba(0,0,0,0.45)] group-hover:bg-secondary group-focus-visible:bg-secondary"><span><span className={`mono-data block text-xs font-semibold ${statusTextClass}`}>{execution.simulatedStatus ?? '—'}</span><span className="mono-data text-[10px] text-muted-foreground">{execution.actualLatencyMs}ms</span></span><ChevronRight size={15} className="shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" /></span>
    </Link>
  );
}
