import * as React from 'react';

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { OrchestrateSpecQuestion } from '@/lib/orchestrate/specClient';

export const SimpleAutoQuestionsDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questions: OrchestrateSpecQuestion[];
  isSubmitting: boolean;
  onSubmit: (answers: Record<string, string>) => void;
}> = ({ open, onOpenChange, questions, isSubmitting, onSubmit }) => {
  const [answers, setAnswers] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    setAnswers({});
  }, [open]);

  const missingRequired = React.useMemo(() => {
    const missing: OrchestrateSpecQuestion[] = [];
    for (const q of questions) {
      if (q.optional === true) {
        continue;
      }
      const value = (answers[q.id] ?? '').trim();
      if (!value) {
        missing.push(q);
      }
    }
    return missing;
  }, [answers, questions]);

  const canSubmit = missingRequired.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-auto" keyboardAvoid>
        <DialogHeader>
          <DialogTitle>Quick Questions</DialogTitle>
          <DialogDescription>
            Answer these so Auto Mode can generate a better spec, then it will start the run automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {questions.map((q) => {
            const value = answers[q.id] ?? '';
            const label = q.optional === true ? `${q.prompt} (optional)` : q.prompt;
            return (
              <div key={q.id} className="space-y-1">
                <div className="typography-ui-label text-foreground">{label}</div>
                {q.kind === 'short_text' ? (
                  <Input
                    value={value}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder={q.placeholder ?? ''}
                    disabled={isSubmitting}
                  />
                ) : (
                  <Textarea
                    value={value}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder={q.placeholder ?? ''}
                    disabled={isSubmitting}
                    className="min-h-[110px]"
                  />
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onSubmit(answers)} disabled={isSubmitting || !canSubmit}>
            {isSubmitting ? 'Starting…' : 'Generate + Start'}
          </Button>
        </DialogFooter>

        {missingRequired.length > 0 ? (
          <div className="typography-micro text-[var(--status-warning)]">
            Required: {missingRequired.map((q) => q.prompt).join(' · ')}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
