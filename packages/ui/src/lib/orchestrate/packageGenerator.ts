export type AutoSimpleForm = {
  title: string;
  description: string;
  doneCriteria: string[];
};

export type AutoAdvancedBundle = {
  spec: string;
  uiSpec: string;
  prompt: string;
  registry: string;
  implementationPlan: string;
  architecturePlan: string;
};

const normalizeLines = (raw: string): string[] => raw.split('\n').map((line) => line.trim());

const parseTitleFromSpec = (spec: string): string => {
  const heading = normalizeLines(spec).find((line) => line.length > 0 && line.startsWith('#'));
  if (heading) {
    return heading.replace(/^#+\s*/, '').trim();
  }

  const firstLine = normalizeLines(spec).find((line) => line.length > 0);
  return firstLine || 'Untitled Objective';
};

const parseDoneCriteria = (spec: string, implementationPlan: string): string[] => {
  const specLines = spec.split('\n');
  const sectionStart = specLines.findIndex((line) => /^##\s+done\s+criteria/i.test(line.trim()));
  const criteriaFromSpec = (sectionStart >= 0 ? specLines.slice(sectionStart + 1) : [])
    .map((line) => line.replace(/^[-*\s]+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);

  if (criteriaFromSpec.length > 0) {
    return criteriaFromSpec;
  }

  const criteriaFromPlan = implementationPlan
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[[ xX]\]/.test(line))
    .map((line) => line.replace(/^[-*]\s+\[[ xX]\]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 20);

  if (criteriaFromPlan.length > 0) {
    return criteriaFromPlan;
  }

  return ['Implementation is correct and verified end-to-end'];
};

const toDocumentSection = (title: string, body: string): string => {
  const value = body.trim() || '_Not specified._';
  return `## ${title}\n\n${value}`;
};

export function seedAdvancedBundle(seed: string): AutoAdvancedBundle {
  const normalizedSeed = seed.trim();
  const shortTitle = normalizedSeed.split('\n')[0]?.trim().slice(0, 120) || 'Define objective';
  const contextualSeed = normalizedSeed || 'Describe what you want to accomplish and key constraints.';

  return {
    spec: [
      `# ${shortTitle}`,
      '',
      '## Problem Statement',
      contextualSeed,
      '',
      '## Scope',
      '- In scope:',
      '- Out of scope:',
      '',
      '## User Flow',
      '1. ',
      '2. ',
      '',
      '## Done Criteria',
      '- ',
      '- ',
    ].join('\n'),
    uiSpec: [
      '# UI Spec',
      '',
      '## Screens',
      '- Primary screen:',
      '- States (empty/loading/success/error):',
      '',
      '## Components',
      '- ',
      '',
      '## Interaction Details',
      '- Keyboard and focus behavior:',
      '- Mobile behavior:',
      '',
      '## Visual Direction',
      '- ',
    ].join('\n'),
    prompt: [
      '# System Prompt Addendum',
      '',
      '## Goal',
      contextualSeed,
      '',
      '## Constraints',
      '- Preserve existing conventions',
      '- Keep diffs minimal and focused',
      '',
      '## Quality Bar',
      '- Include tests or validation where relevant',
      '- Explain tradeoffs for important decisions',
    ].join('\n'),
    registry: [
      '# Registry',
      '',
      '## Variables',
      '- (none)',
      '',
      '## Functions',
      '- (none)',
    ].join('\n'),
    implementationPlan: [
      '# Implementation Plan',
      '',
      '- [ ] Analyze relevant modules and constraints',
      '- [ ] Implement core behavior changes',
      '- [ ] Implement UI or integration updates',
      '- [ ] Validate with type-check/lint/build and smoke test',
    ].join('\n'),
    architecturePlan: [
      '# Architecture Plan',
      '',
      '## Existing Architecture',
      '- Runtime and entry points impacted:',
      '- Data flow touched:',
      '',
      '## Proposed Changes',
      '- ',
      '',
      '## Risks and Mitigations',
      '- Risk:',
      '- Mitigation:',
    ].join('\n'),
  };
}

export function generateSpecMarkdown(form: AutoSimpleForm): string {
  const title = form.title.trim() || 'Untitled Objective';
  const description = form.description.trim();
  const criteria = (form.doneCriteria || []).map((c) => c.trim()).filter(Boolean);

  return [
    `# ${title}`,
    '',
    description || '_No description provided._',
    '',
    '## Done Criteria',
    ...(criteria.length > 0 ? criteria.map((c) => `- ${c}`) : ['- _Not specified_']),
  ].join('\n');
}

export function generateOrchestrationPackage(input: {
  form: AutoSimpleForm;
  model: string;
  createdBy?: string;
  previewCwd?: string;
}): Record<string, unknown> {
  const now = new Date().toISOString();
  const packageId = `oc_pkg_${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)}`;

  const title = input.form.title.trim() || 'Untitled Objective';
  const description = input.form.description.trim() || input.form.title.trim() || 'Objective not provided.';
  const doneCriteria = (input.form.doneCriteria || []).map((c) => c.trim()).filter(Boolean);

  return {
    packageVersion: '0.1.0',
    metadata: {
      packageId,
      createdAt: now,
      createdBy: (input.createdBy || 'unloveable').slice(0, 64),
      source: 'unloveable:auto',
      tags: ['auto-mode'],
    },
    objective: {
      title,
      description,
      inputs: {},
      doneCriteria: (doneCriteria.length > 0 ? doneCriteria : ['Deliver a correct, working result']).map((c, idx) => ({
        id: `done_${idx + 1}`,
        description: c,
        requiredEvidenceTypes: ['diff', 'log_excerpt', 'test_result'],
      })),
    },
    agents: {
      orchestrator: {
        name: 'orchestrator',
        model: input.model,
        systemPromptRef: 'openchamber/orchestrator-system',
      },
      worker: {
        name: 'worker',
        model: input.model,
        systemPromptRef: 'openchamber/worker-system',
      },
    },
    registries: {
      skills: [],
      variables: [],
    },
    runPolicy: {
      limits: {
        maxOrchestratorIterations: 4,
        maxWorkerIterations: 6,
        maxRunWallClockMs: 2 * 60 * 60 * 1000,
      },
      retries: {
        maxWorkerTaskRetries: 1,
        maxMalformedOutputRetries: 3,
      },
      concurrency: {
        maxWorkers: 4,
      },
      timeouts: {
        // Worker tasks can involve installs/builds; keep generous by default.
        workerTaskMs: 10 * 60 * 1000,
        orchestratorStepMs: 5 * 60 * 1000,
      },
      budget: {
        maxTokens: 250_000,
        maxCostUsd: 25,
      },
      determinism: {
        enforceStageOrder: true,
        requireStrictJson: true,
        singleSessionPerRun: true,
      },
    },
    preview: input.previewCwd
      ? {
          enabled: true,
          cwd: input.previewCwd,
          command: 'bun',
          args: ['run', 'dev', '--', '--port', '{PORT}', '--host', '127.0.0.1'],
          readyPath: '/',
          autoStopOnTerminal: true,
        }
      : {
          enabled: false,
        },
    git: input.previewCwd
      ? {
          enabled: true,
          repoPath: input.previewCwd,
          worktreesRoot: `${input.previewCwd.replace(/\/+$/, '')}/.orchestrate-worktrees/${packageId}`,
          baseBranch: 'main',
          integrationBranch: `oc/integration/${packageId}`,
          requireChecks: [],
        }
      : {
          enabled: false,
        },
  };
}

export function generateOrchestrationPackageFromAdvancedBundle(input: {
  bundle: AutoAdvancedBundle;
  model: string;
  createdBy?: string;
  previewCwd?: string;
}): Record<string, unknown> {
  const now = new Date().toISOString();
  const packageId = `oc_pkg_${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)}`;

  const title = parseTitleFromSpec(input.bundle.spec);
  const doneCriteria = parseDoneCriteria(input.bundle.spec, input.bundle.implementationPlan);

  const description = [
    toDocumentSection('Spec', input.bundle.spec),
    toDocumentSection('UI Spec', input.bundle.uiSpec),
    toDocumentSection('Prompt', input.bundle.prompt),
    toDocumentSection('Registry', input.bundle.registry),
    toDocumentSection('Implementation Plan', input.bundle.implementationPlan),
    toDocumentSection('Architecture Plan', input.bundle.architecturePlan),
  ].join('\n\n');

  return {
    packageVersion: '0.1.0',
    metadata: {
      packageId,
      createdAt: now,
      createdBy: (input.createdBy || 'unloveable').slice(0, 64),
      source: 'unloveable:auto',
      tags: ['auto-mode', 'advanced-bundle'],
    },
    objective: {
      title,
      description,
      inputs: {
        promptMd: input.bundle.prompt,
        specMd: input.bundle.spec,
        uiSpecMd: input.bundle.uiSpec,
        registryMd: input.bundle.registry,
        implementationPlanMd: input.bundle.implementationPlan,
        architecturePlanMd: input.bundle.architecturePlan,
        specBundle: {
          spec: input.bundle.spec,
          uiSpec: input.bundle.uiSpec,
          prompt: input.bundle.prompt,
          registry: input.bundle.registry,
          implementationPlan: input.bundle.implementationPlan,
          architecturePlan: input.bundle.architecturePlan,
        },
      },
      doneCriteria: doneCriteria.map((criterion, idx) => ({
        id: `done_${idx + 1}`,
        description: criterion,
        requiredEvidenceTypes: ['diff', 'log_excerpt', 'test_result'],
      })),
    },
    agents: {
      orchestrator: {
        name: 'orchestrator',
        model: input.model,
        systemPromptRef: 'openchamber/orchestrator-system',
      },
      worker: {
        name: 'worker',
        model: input.model,
        systemPromptRef: 'openchamber/worker-system',
      },
    },
    registries: {
      skills: [],
      variables: [],
      uiSpecs: [
        {
          id: 'primary-ui-spec',
          format: 'markdown',
          content: input.bundle.uiSpec,
        },
      ],
    },
    runPolicy: {
      limits: {
        maxOrchestratorIterations: 6,
        maxWorkerIterations: 8,
        maxRunWallClockMs: 2 * 60 * 60 * 1000,
      },
      retries: {
        maxWorkerTaskRetries: 2,
        maxMalformedOutputRetries: 3,
      },
      concurrency: {
        maxWorkers: 4,
      },
      timeouts: {
        workerTaskMs: 10 * 60 * 1000,
        orchestratorStepMs: 5 * 60 * 1000,
      },
      budget: {
        maxTokens: 350_000,
        maxCostUsd: 30,
      },
      determinism: {
        enforceStageOrder: true,
        requireStrictJson: true,
        singleSessionPerRun: true,
      },
    },
    preview: input.previewCwd
      ? {
          enabled: true,
          cwd: input.previewCwd,
          command: 'bun',
          args: ['run', 'dev', '--', '--port', '{PORT}', '--host', '127.0.0.1'],
          readyPath: '/',
          autoStopOnTerminal: true,
        }
      : {
          enabled: false,
        },
    git: input.previewCwd
      ? {
          enabled: true,
          repoPath: input.previewCwd,
          worktreesRoot: `${input.previewCwd.replace(/\/+$/, '')}/.orchestrate-worktrees/${packageId}`,
          baseBranch: 'main',
          integrationBranch: `oc/integration/${packageId}`,
          requireChecks: [],
        }
      : {
          enabled: false,
        },
  };
}
