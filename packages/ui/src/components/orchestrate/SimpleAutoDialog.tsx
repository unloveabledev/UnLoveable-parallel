import * as React from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { orchestrateCreateRun } from '@/lib/orchestrate/client';
import { generateOrchestrationPackage, generateSpecMarkdown, type AutoSimpleForm } from '@/lib/orchestrate/packageGenerator';
import { orchestrateGenerateSpec } from '@/lib/orchestrate/specClient';

export type SimpleAutoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultGoalText?: string;
  model: string;
  previewCwd?: string | null;
  onCreatedRun: (runId: string) => void;
};

const parseCriteriaLines = (raw: string): string[] => {
  return raw
    .split('\n')
    .map((line) => line.replace(/^[-*\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 20);
};

export const SimpleAutoDialog: React.FC<SimpleAutoDialogProps> = ({
  open,
  onOpenChange,
  defaultGoalText,
  model,
  previewCwd,
  onCreatedRun,
}) => {
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [criteriaText, setCriteriaText] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [remoteSpec, setRemoteSpec] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const seed = (defaultGoalText ?? '').trim();
    if (!seed) return;
    // Heuristic: short single-line -> title, else title from first line.
    const lines = seed.split('\n').map((l) => l.trim()).filter(Boolean);
    const first = lines[0] ?? '';
    if (!title) {
      setTitle(first.slice(0, 120));
    }
    if (!description) {
      setDescription(lines.slice(1).join('\n').trim() || seed);
    }
  }, [defaultGoalText, description, open, title]);

  const form: AutoSimpleForm = React.useMemo(() => ({
    title,
    description,
    doneCriteria: parseCriteriaLines(criteriaText),
  }), [criteriaText, description, title]);

  const spec = React.useMemo(() => generateSpecMarkdown(form), [form]);
  const displayedSpec = remoteSpec ?? spec;

  const handleGenerateSpec = React.useCallback(async () => {
    setIsGenerating(true);
    try {
      const result = await orchestrateGenerateSpec({ prompt: [title, description].filter(Boolean).join('\n\n'), model });
      const doc = Array.isArray(result.documents) ? result.documents.find((d) => d?.path === 'SPEC.md') : null;
      if (doc && typeof doc.content === 'string') {
        setRemoteSpec(doc.content);
      }
      toast.success('Spec generated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to generate spec');
    } finally {
      setIsGenerating(false);
    }
  }, [description, model, title]);

  const handleRun = React.useCallback(async () => {
    setIsCreating(true);
    try {
      const pkg = generateOrchestrationPackage({ form, model, previewCwd: previewCwd ?? undefined });
      const created = await orchestrateCreateRun(pkg);
      onOpenChange(false);
      onCreatedRun(created.id);
      toast.success('Run started');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start run');
    } finally {
      setIsCreating(false);
    }
  }, [form, model, onCreatedRun, onOpenChange, previewCwd]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-auto" keyboardAvoid>
        <DialogHeader>
          <DialogTitle>Simple Auto</DialogTitle>
          <div className="typography-meta text-muted-foreground">
            Answer a few questions, review the generated spec, then start an Orchestrate run.
          </div>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="typography-ui-label text-foreground">Goal</div>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What do you want to build or change?"
                disabled={isCreating}
              />
            </div>

            <div className="space-y-1">
              <div className="typography-ui-label text-foreground">Details</div>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Context, constraints, important files, non-goals…"
                disabled={isCreating}
                className="min-h-[160px]"
              />
            </div>

            <div className="space-y-1">
              <div className="typography-ui-label text-foreground">Done Criteria (one per line)</div>
              <Textarea
                value={criteriaText}
                onChange={(e) => setCriteriaText(e.target.value)}
                placeholder={"- Tests pass\n- Feature works end-to-end\n- Docs updated"}
                disabled={isCreating}
                className="min-h-[120px] font-mono text-xs"
              />
            </div>

            <div className="typography-micro text-muted-foreground font-mono">Model: {model}</div>
          </div>

          <div className="space-y-1 min-h-0">
          <div className="typography-ui-label text-foreground">Generated Spec</div>
            <Textarea
              value={displayedSpec}
              readOnly
              className="min-h-[320px] lg:min-h-[420px] font-mono text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={isCreating}>
            Close
          </Button>
          <Button type="button" variant="secondary" onClick={() => void handleGenerateSpec()} disabled={isCreating || isGenerating || title.trim().length === 0}>
            {isGenerating ? 'Generating…' : 'Generate Spec'}
          </Button>
          <Button type="button" onClick={() => void handleRun()} disabled={isCreating || title.trim().length === 0}>
            {isCreating ? 'Starting…' : 'Start Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
