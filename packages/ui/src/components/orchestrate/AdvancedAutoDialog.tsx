import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { toast } from '@/components/ui';
import { AnimatedTabs } from '@/components/ui/animated-tabs';
import { orchestrateCreateRun } from '@/lib/orchestrate/client';
import { orchestrateDocAssist, orchestrateGenerateSpecStream, type OrchestrateSpecProgressEvent } from '@/lib/orchestrate/specClient';
import {
  generateOrchestrationPackageFromAdvancedBundle,
  seedAdvancedBundle,
  type AutoAdvancedBundle,
} from '@/lib/orchestrate/packageGenerator';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import type { Extension } from '@codemirror/state';

type BundleKey = keyof AutoAdvancedBundle;

type BundleTab = {
  key: BundleKey;
  label: string;
  description: string;
  pseudoPath: string;
};

const BUNDLE_TABS: BundleTab[] = [
  {
    key: 'spec',
    label: 'Spec',
    description: 'Primary problem statement, scope, user flow, and done criteria.',
    pseudoPath: 'spec.md',
  },
  {
    key: 'uiSpec',
    label: 'UI Spec',
    description: 'Interaction details, component behavior, and visual requirements.',
    pseudoPath: 'ui-spec.md',
  },
  {
    key: 'prompt',
    label: 'Prompt',
    description: 'Prompt guidance and constraints for orchestration.',
    pseudoPath: 'prompt.md',
  },
  {
    key: 'registry',
    label: 'Registry',
    description: 'Variables/functions registry for consistent naming and interfaces.',
    pseudoPath: 'registry.md',
  },
  {
    key: 'implementationPlan',
    label: 'Implementation Plan',
    description: 'Execution checklist and verification sequence.',
    pseudoPath: 'implementation-plan.md',
  },
  {
    key: 'architecturePlan',
    label: 'Architecture Plan',
    description: 'System-level impact, decisions, and risk mitigation.',
    pseudoPath: 'architecture-plan.md',
  },
];

const createInitialBundle = (goalText?: string): AutoAdvancedBundle => seedAdvancedBundle(goalText ?? '');

const compactExtensions = (extensions: Array<Extension | null>): Extension[] =>
  extensions.filter((extension): extension is Extension => extension !== null);

const formatDateTime = (value: string | null): string => {
  if (!value) return 'Not generated yet';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return 'Not generated yet';
  return parsed.toLocaleString();
};

export type AdvancedAutoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultGoalText?: string;
  model: string;
  previewCwd?: string | null;
  onCreatedRun: (runId: string) => void;
};

export const AdvancedAutoDialog: React.FC<AdvancedAutoDialogProps> = ({
  open,
  onOpenChange,
  defaultGoalText,
  model,
  previewCwd,
  onCreatedRun,
}) => {
  const { currentTheme } = useThemeSystem();
  const [bundle, setBundle] = React.useState<AutoAdvancedBundle>(() => createInitialBundle(defaultGoalText));
  const [activeTab, setActiveTab] = React.useState<BundleKey>('spec');
  const [lastGeneratedAt, setLastGeneratedAt] = React.useState<string | null>(null);
  const [isApproved, setIsApproved] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [assistantBusy, setAssistantBusy] = React.useState(false);
  const [assistantInput, setAssistantInput] = React.useState('');
  const [assistantMessages, setAssistantMessages] = React.useState<Array<{ id: string; role: 'user' | 'assistant'; text: string }>>([]);
  const [specProgress, setSpecProgress] = React.useState<OrchestrateSpecProgressEvent | null>(null);
  const [specProgressLog, setSpecProgressLog] = React.useState<string[]>([]);

  const autoGenerateAttemptedRef = React.useRef(false);

  const editorExtensions = React.useMemo(
    () => compactExtensions([createFlexokiCodeMirrorTheme(currentTheme), languageByExtension('bundle.md')]),
    [currentTheme],
  );

  const activeTabMeta = React.useMemo(() => BUNDLE_TABS.find((tab) => tab.key === activeTab) ?? BUNDLE_TABS[0], [activeTab]);
  const canApply = !isCreating && !isGenerating && !assistantBusy && isApproved;

  React.useEffect(() => {
    if (!open) return;
    setBundle((prev) => {
      if (prev.spec.trim().length > 0 || prev.uiSpec.trim().length > 0) {
        return prev;
      }
      return createInitialBundle(defaultGoalText);
    });
  }, [defaultGoalText, open]);

  const updateBundleDoc = React.useCallback((key: BundleKey, value: string) => {
    setBundle((prev) => {
      if (prev[key] === value) return prev;
      return { ...prev, [key]: value };
    });
    setIsApproved(false);
  }, []);

  const handleResetBundle = React.useCallback(() => {
    setBundle(createInitialBundle(defaultGoalText));
    setIsApproved(false);
    setAssistantMessages([]);
    toast.success('Spec bundle reset');
  }, [defaultGoalText]);

  const handleGenerateSpecBundle = React.useCallback(async () => {
    if (isGenerating) {
      return;
    }
    setIsGenerating(true);
    setSpecProgress({ phase: 'start', message: 'Starting…', percent: 0 });
    setSpecProgressLog([]);
    try {
      const seedPrompt = (defaultGoalText ?? '').trim() || bundle.spec;
      const result = await orchestrateGenerateSpecStream({
        prompt: seedPrompt,
        model,
        context: { directory: previewCwd ?? undefined },
        onProgress: (evt) => {
          setSpecProgress(evt);
          setSpecProgressLog((prev) => {
            const next = [...prev, evt.message];
            return next.length > 8 ? next.slice(next.length - 8) : next;
          });
        },
      });
      const specDoc = Array.isArray(result.documents) ? result.documents.find((d) => d?.path === 'SPEC.md') : null;
      const promptDoc = Array.isArray(result.documents) ? result.documents.find((d) => d?.path === 'PROMPT.md') : null;
      const uiSpecDoc = Array.isArray(result.documents) ? result.documents.find((d) => d?.path === 'UI_SPEC.md') : null;
      const implementationDoc = Array.isArray(result.documents)
        ? result.documents.find((d) => d?.path === 'IMPLEMENTATION_PLAN.md')
        : null;
      const architectureDoc = Array.isArray(result.documents)
        ? result.documents.find((d) => d?.path === 'ARCHITECTURE_PLAN.md')
        : null;
      const registryDoc = Array.isArray(result.documents)
        ? result.documents.find((d) => d?.path === 'REGISTRY.md')
        : null;

      setBundle((prev) => ({
        ...prev,
        spec: specDoc && typeof specDoc.content === 'string' ? specDoc.content : prev.spec,
        prompt: promptDoc && typeof promptDoc.content === 'string' ? promptDoc.content : prev.prompt,
        uiSpec: uiSpecDoc && typeof uiSpecDoc.content === 'string' ? uiSpecDoc.content : prev.uiSpec,
        registry: registryDoc && typeof registryDoc.content === 'string' ? registryDoc.content : prev.registry,
        implementationPlan:
          implementationDoc && typeof implementationDoc.content === 'string' ? implementationDoc.content : prev.implementationPlan,
        architecturePlan:
          architectureDoc && typeof architectureDoc.content === 'string' ? architectureDoc.content : prev.architecturePlan,
      }));
      setIsApproved(false);

      const now = new Date().toISOString();
      setLastGeneratedAt(now);

      toast.success('Spec bundle generated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate spec bundle');
    } finally {
      setIsGenerating(false);
    }
  }, [bundle.spec, defaultGoalText, isGenerating, model, previewCwd]);

  React.useEffect(() => {
    if (!open) {
      autoGenerateAttemptedRef.current = false;
      return;
    }
    if (autoGenerateAttemptedRef.current) return;
    if (isGenerating) return;
    const seed = (defaultGoalText ?? '').trim();
    if (!seed) return;

    // Attempt auto-generation exactly once per open.
    autoGenerateAttemptedRef.current = true;
    void handleGenerateSpecBundle();
  }, [defaultGoalText, handleGenerateSpecBundle, isGenerating, open]);

  const handleAssistantSend = React.useCallback(async () => {
    const instruction = assistantInput.trim();
    if (!instruction) {
      toast.error('Type an instruction for the assistant.');
      return;
    }
    if (assistantBusy) {
      return;
    }

    const requestDocs = {
      promptMd: bundle.prompt,
      specMd: bundle.spec,
      uiSpecMd: bundle.uiSpec,
      architecturePlanMd: bundle.architecturePlan,
      registryMd: bundle.registry,
      implementationPlanMd: bundle.implementationPlan,
    };

    setAssistantBusy(true);
    setAssistantInput('');
    setAssistantMessages((prev) => [
      ...prev,
      { id: `m_${Date.now()}_u`, role: 'user', text: instruction },
    ]);

    try {
      const result = await orchestrateDocAssist({
        instruction,
        model,
        docs: requestDocs,
        context: { directory: previewCwd ?? undefined },
      });

      setAssistantMessages((prev) => [
        ...prev,
        { id: `m_${Date.now()}_a`, role: 'assistant', text: 'Applied doc updates.' },
      ]);

      setBundle((prev) => ({
        ...prev,
        prompt: result.docs.promptMd,
        spec: result.docs.specMd,
        uiSpec: result.docs.uiSpecMd,
        architecturePlan: result.docs.architecturePlanMd,
        registry: result.docs.registryMd,
        implementationPlan: result.docs.implementationPlanMd,
      }));
      setIsApproved(false);
      toast.success('Assistant applied updates to your bundle');
    } catch (error) {
      setAssistantMessages((prev) => [
        ...prev,
        { id: `m_${Date.now()}_a_err`, role: 'assistant', text: error instanceof Error ? error.message : 'Doc assist failed' },
      ]);
      toast.error(error instanceof Error ? error.message : 'Doc assist failed');
    } finally {
      setAssistantBusy(false);
    }
  }, [assistantBusy, assistantInput, bundle, model, previewCwd]);

  const handleRun = React.useCallback(async () => {
    if (!canApply) {
      toast.error('Approve the bundle before applying.');
      return;
    }

    setIsCreating(true);
    try {
      const pkg = generateOrchestrationPackageFromAdvancedBundle({
        bundle,
        model,
        createdBy: 'unloveable:advanced',
        previewCwd: previewCwd ?? undefined,
      });
      const created = await orchestrateCreateRun(pkg);
      onOpenChange(false);
      onCreatedRun(created.id);
      toast.success('Run started');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start run');
    } finally {
      setIsCreating(false);
    }
  }, [bundle, canApply, model, onCreatedRun, onOpenChange, previewCwd]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-screen h-[100dvh] max-w-none max-h-none rounded-none border-0 p-0 gap-0 overflow-hidden !top-0 !left-0 !translate-x-0 !translate-y-0"
        keyboardAvoid
      >
        <DialogHeader className="px-5 py-4 border-b border-border bg-muted/30">
          <DialogTitle>Advanced Auto</DialogTitle>
          <DialogDescription>
            Review and edit Spec, UI Spec, Prompt, Registry, Implementation Plan, and Architecture Plan before generating final package JSON.
          </DialogDescription>
          <div className="flex items-center justify-end pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleGenerateSpecBundle()}
              disabled={isCreating || isGenerating}
            >
              {isGenerating ? 'Generating…' : 'Generate Spec Bundle'}
            </Button>
            {isGenerating ? (
              <div className="ml-3 min-w-0">
                <div className="typography-micro text-muted-foreground truncate">
                  {specProgress?.message ?? 'Working…'}
                </div>
                {specProgressLog.length > 1 ? (
                  <div className="typography-micro text-muted-foreground truncate">
                    {specProgressLog[specProgressLog.length - 2]}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogHeader>

        <div className="grid h-[calc(100dvh-170px)] min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
          <div className="min-h-0 flex flex-col border-r border-border">
            <div className="px-4 py-3 border-b border-border bg-[var(--surface-muted)]">
              <AnimatedTabs<BundleKey>
                value={activeTab}
                onValueChange={setActiveTab}
                size="sm"
                collapseLabelsOnSmall
                collapseLabelsOnNarrow
                tabs={BUNDLE_TABS.map((t) => ({ value: t.key, label: t.label }))}
              />
              <div className="pt-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="typography-ui-label text-foreground">{activeTabMeta.label}</div>
                  <div className="typography-micro text-muted-foreground font-mono truncate">{activeTabMeta.pseudoPath}</div>
                  <div className="typography-micro text-muted-foreground pt-1 line-clamp-2">{activeTabMeta.description}</div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <div className="hidden md:block text-right">
                    <div className="typography-micro text-muted-foreground">Model</div>
                    <div className="typography-micro text-foreground font-mono">{model}</div>
                    <div className="typography-micro text-muted-foreground pt-1">Last generated</div>
                    <div className="typography-micro text-foreground">{formatDateTime(lastGeneratedAt)}</div>
                  </div>
                  <Button type="button" variant="secondary" onClick={handleResetBundle} disabled={isCreating || isGenerating || assistantBusy}>
                    Reset
                  </Button>
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <CodeMirrorEditor
                value={bundle[activeTab]}
                onChange={(value) => updateBundleDoc(activeTab, value)}
                extensions={editorExtensions}
                className="[&_.cm-editor]:bg-background [&_.cm-scroller]:px-3 [&_.cm-scroller]:py-3"
              />
            </div>
          </div>

          <div className="min-h-0 flex flex-col border-l border-border">
            <div className="px-4 py-2 border-b border-border">
              <div className="typography-ui-label text-foreground">Assistant</div>
              <div className="typography-micro text-muted-foreground">Give an instruction; it will update the bundle docs.</div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3 space-y-2">
              {assistantMessages.length === 0 ? (
                <div className="typography-meta text-muted-foreground">
                  Example: “Tighten the scope to exclude desktop runtime; add explicit validation commands.”
                </div>
              ) : null}
              {assistantMessages.map((m) => (
                <div
                  key={m.id}
                  className="rounded-md border border-border px-3 py-2"
                  style={{ backgroundColor: m.role === 'user' ? currentTheme.colors.surface.elevated : currentTheme.colors.surface.muted }}
                >
                  <div className="typography-micro text-muted-foreground font-mono">{m.role}</div>
                  <div className="typography-meta text-foreground whitespace-pre-wrap">{m.text}</div>
                </div>
              ))}
            </div>
            <div className="border-t border-border px-4 py-3 bg-[var(--surface-muted)]">
              <textarea
                className="w-full min-h-[80px] resize-none rounded-md border border-border bg-[var(--surface-elevated)] p-2 typography-meta text-foreground"
                value={assistantInput}
                onChange={(e) => setAssistantInput(e.target.value)}
                placeholder="Ask the assistant to adjust the docs…"
                disabled={assistantBusy || isCreating}
              />
              <div className="pt-2 flex items-center justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setAssistantMessages([])} disabled={assistantBusy || isCreating}>
                  Clear
                </Button>
                <Button type="button" onClick={() => void handleAssistantSend()} disabled={assistantBusy || isCreating}>
                  {assistantBusy ? 'Working…' : 'Update Docs'}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="px-5 py-3 border-t border-border bg-muted/20 items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Checkbox
              checked={isApproved}
              onChange={setIsApproved}
              disabled={isCreating}
              ariaLabel="Approval checkbox"
            />
            <span className="typography-meta text-muted-foreground truncate">
              I reviewed the spec bundle and approve generating/running this package.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={isCreating}>
              Close
            </Button>
            <Button type="button" onClick={() => void handleRun()} disabled={!canApply}>
              {isCreating ? 'Applying…' : 'Apply'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
