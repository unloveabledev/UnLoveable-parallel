import * as React from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { toast } from '@/components/ui';
import { orchestrateCreateRun } from '@/lib/orchestrate/client';
import { orchestrateGenerateSpec } from '@/lib/orchestrate/specClient';
import {
  generateOrchestrationPackageFromAdvancedBundle,
  seedAdvancedBundle,
  type AutoAdvancedBundle,
} from '@/lib/orchestrate/packageGenerator';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { EditorView } from '@codemirror/view';
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
  const [pkgJson, setPkgJson] = React.useState('');
  const [lastGeneratedAt, setLastGeneratedAt] = React.useState<string | null>(null);
  const [draftRevision, setDraftRevision] = React.useState(0);
  const [generatedRevision, setGeneratedRevision] = React.useState(-1);
  const [isApproved, setIsApproved] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [isGenerating, setIsGenerating] = React.useState(false);

  const editorExtensions = React.useMemo(
    () => compactExtensions([createFlexokiCodeMirrorTheme(currentTheme), languageByExtension('bundle.md')]),
    [currentTheme],
  );

  const jsonExtensions = React.useMemo(
    () => compactExtensions([createFlexokiCodeMirrorTheme(currentTheme), languageByExtension('package.json'), EditorView.lineWrapping]),
    [currentTheme],
  );

  const activeTabMeta = React.useMemo(() => BUNDLE_TABS.find((tab) => tab.key === activeTab) ?? BUNDLE_TABS[0], [activeTab]);
  const isPackageStale = generatedRevision !== draftRevision;
  const canStartRun = !isCreating && isApproved && !isPackageStale && pkgJson.trim().length > 0;

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
    setDraftRevision((prev) => prev + 1);
    setIsApproved(false);
  }, []);

  const handleGeneratePackage = React.useCallback(() => {
    try {
      const pkg = generateOrchestrationPackageFromAdvancedBundle({
        bundle,
        model,
        createdBy: 'unloveable:advanced',
        previewCwd: previewCwd ?? undefined,
      });
      setPkgJson(JSON.stringify(pkg, null, 2));
      setGeneratedRevision(draftRevision);
      const now = new Date().toISOString();
      setLastGeneratedAt(now);
      toast.success('Detailed package JSON generated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate package');
    }
  }, [bundle, draftRevision, model, previewCwd]);

  const handleResetBundle = React.useCallback(() => {
    setBundle(createInitialBundle(defaultGoalText));
    setDraftRevision((prev) => prev + 1);
    setIsApproved(false);
    toast.success('Spec bundle reset');
  }, [defaultGoalText]);

  const handleGenerateSpecBundle = React.useCallback(async () => {
    setIsGenerating(true);
    try {
      const seedPrompt = bundle.spec.trim().length > 0 ? bundle.spec : (defaultGoalText ?? '');
      const result = await orchestrateGenerateSpec({ prompt: seedPrompt, model });
      const specDoc = Array.isArray(result.documents) ? result.documents.find((d) => d?.path === 'SPEC.md') : null;
      const tasksDoc = Array.isArray(result.documents) ? result.documents.find((d) => d?.path === 'TASKS.md') : null;
      const pkgDoc = Array.isArray(result.documents)
        ? result.documents.find((d) => d?.path === 'ORCHESTRATION_PACKAGE.json')
        : null;

      setBundle((prev) => ({
        ...prev,
        spec: specDoc && typeof specDoc.content === 'string' ? specDoc.content : prev.spec,
        implementationPlan:
          tasksDoc && typeof tasksDoc.content === 'string' ? tasksDoc.content : prev.implementationPlan,
      }));
      setDraftRevision((prev) => prev + 1);
      setIsApproved(false);

      if (pkgDoc && typeof pkgDoc.content === 'string') {
        setPkgJson(pkgDoc.content);
        // Mark JSON as stale; user should explicitly Generate JSON after edits/approval.
        setGeneratedRevision(-1);
      }

      toast.success('Spec bundle generated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate spec bundle');
    } finally {
      setIsGenerating(false);
    }
  }, [bundle.spec, defaultGoalText, model]);

  const handleRun = React.useCallback(async () => {
    if (!canStartRun) {
      toast.error('Approve and regenerate JSON after the latest edits before starting the run.');
      return;
    }

    setIsCreating(true);
    try {
      const parsed = JSON.parse(pkgJson) as unknown;
      const created = await orchestrateCreateRun(parsed);
      onOpenChange(false);
      onCreatedRun(created.id);
      toast.success('Run started');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start run');
    } finally {
      setIsCreating(false);
    }
  }, [canStartRun, onCreatedRun, onOpenChange, pkgJson]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-screen h-[100dvh] max-w-none max-h-none rounded-none border-0 p-0 gap-0 overflow-hidden !top-0 !left-0 !translate-x-0 !translate-y-0"
        keyboardAvoid
      >
        <DialogHeader className="px-5 py-4 border-b border-border bg-muted/30">
          <DialogTitle>Advanced Auto</DialogTitle>
          <div className="typography-meta text-muted-foreground">
            Review and edit Spec, UI Spec, Prompt, Implementation Plan, and Architecture Plan before generating final package JSON.
          </div>
          <div className="flex items-center justify-end pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleGenerateSpecBundle()}
              disabled={isCreating || isGenerating}
            >
              {isGenerating ? 'Generating…' : 'Generate Spec Bundle'}
            </Button>
          </div>
        </DialogHeader>

        <div className="grid h-[calc(100dvh-170px)] min-h-0 lg:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="border-r border-border bg-muted/20 min-h-0 overflow-auto p-3 space-y-2">
            <div className="typography-ui-label text-foreground px-2">Spec Bundle</div>
            {BUNDLE_TABS.map((tab) => {
              const isActive = tab.key === activeTab;
              return (
                <button
                  key={tab.key}
                  type="button"
                  className="w-full text-left rounded-lg border px-3 py-2 transition-colors"
                  style={{
                    borderColor: isActive ? currentTheme.colors.interactive.selection : currentTheme.colors.interactive.border,
                    backgroundColor: isActive ? currentTheme.colors.interactive.selection : currentTheme.colors.surface.elevated,
                    color: isActive ? currentTheme.colors.interactive.selectionForeground : currentTheme.colors.surface.foreground,
                  }}
                  onClick={() => setActiveTab(tab.key)}
                  disabled={isCreating}
                >
                  <div className="typography-meta font-semibold">{tab.label}</div>
                  <div className="typography-micro opacity-80 line-clamp-2">{tab.description}</div>
                </button>
              );
            })}
            <div className="mt-3 rounded-lg border border-border bg-background p-3">
              <div className="typography-micro text-muted-foreground">Model</div>
              <div className="typography-meta text-foreground font-mono">{model}</div>
              <div className="typography-micro text-muted-foreground mt-2">Last generated</div>
              <div className="typography-meta text-foreground">{formatDateTime(lastGeneratedAt)}</div>
            </div>
          </div>

          <div className="min-h-0 flex flex-col border-r border-border">
            <div className="px-4 py-2 border-b border-border flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="typography-ui-label text-foreground">{activeTabMeta.label}</div>
                <div className="typography-micro text-muted-foreground font-mono">{activeTabMeta.pseudoPath}</div>
              </div>
              <Button type="button" variant="secondary" onClick={handleResetBundle} disabled={isCreating}>
                Reset Bundle
              </Button>
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

          <div className="min-h-0 flex flex-col">
            <div className="px-4 py-2 border-b border-border flex items-center justify-between gap-2">
              <div>
                <div className="typography-ui-label text-foreground">OrchestrationPackage (JSON)</div>
                <div className="typography-micro text-muted-foreground">
                  {isPackageStale ? 'Bundle changed, regenerate JSON before starting run.' : 'JSON is synced with current spec bundle.'}
                </div>
              </div>
              <Button type="button" variant="secondary" onClick={handleGeneratePackage} disabled={isCreating}>
                Generate JSON
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <CodeMirrorEditor
              value={pkgJson}
              onChange={setPkgJson}
                extensions={jsonExtensions}
                className="[&_.cm-editor]:bg-background [&_.cm-scroller]:px-3 [&_.cm-scroller]:py-3"
                readOnly={isCreating}
              />
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
          <Button type="button" onClick={() => void handleRun()} disabled={!canStartRun}>
            {isCreating ? 'Starting…' : 'Start Run'}
          </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
