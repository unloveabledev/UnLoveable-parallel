import { randomUUID } from 'node:crypto'
import type { OrchestrateDb } from './db.js'
import type { AgentResult, AgentTask, OrchestrationPackage, RunEvent, RunRecord, RunStatus } from './types.js'

interface RunRow {
  id: string
  status: RunStatus
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
  reason: string | null
  cancel_requested: number
  session_id: string | null
  package_json: string
  budget_tokens_used: number
  budget_cost_used: number
}

interface EventRow {
  run_id: string
  event_id: number
  event_type: string
  event_data_json: string
  created_at: string
}

interface TaskRow {
  task_id: string
  run_id: string
  status: string
  retries_used: number
  payload_json: string
  updated_at: string
}

interface ResultRow {
  result_id: string
  run_id: string
  task_id: string | null
  agent_role: string
  stage: string
  status: string
  payload_json: string
  created_at: string
}

interface EvidenceRow {
  evidence_id: string
  run_id: string
  task_id: string | null
  result_id: string | null
  type: string
  uri: string
  hash: string
  description: string
  metadata_json: string | null
  created_at: string
}

interface ArtifactRow {
  artifact_id: string
  run_id: string
  task_id: string | null
  result_id: string | null
  kind: string
  uri: string
  size_bytes: number | null
  created_at: string
}

export class Repository {
  private readonly db: OrchestrateDb

  constructor(db: OrchestrateDb) {
    this.db = db
  }

  createRun(orchestrationPackage: OrchestrationPackage): RunRecord {
    const now = new Date().toISOString()
    const id = `run_${randomUUID()}`

    this.db
      .prepare(
        `INSERT INTO runs (
          id, status, created_at, updated_at, package_json, budget_tokens_used, budget_cost_used
        ) VALUES (?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(id, 'queued', now, now, JSON.stringify(orchestrationPackage))

    return this.getRunOrThrow(id)
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
    if (!row) {
      return null
    }
    return this.mapRun(row)
  }

  getRunOrThrow(id: string): RunRecord {
    const run = this.getRun(id)
    if (!run) {
      throw new Error(`run not found: ${id}`)
    }
    return run
  }

  listRunEvents(runId: string, afterEventId = 0): RunEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND event_id > ? ORDER BY event_id ASC')
      .all(runId, afterEventId) as EventRow[]

    return rows.map((row) => ({
      runId: row.run_id,
      eventId: row.event_id,
      type: row.event_type,
      data: JSON.parse(row.event_data_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }))
  }

  appendEvent(runId: string, type: string, data: Record<string, unknown>): RunEvent {
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT COALESCE(MAX(event_id), 0) AS latest FROM events WHERE run_id = ?')
        .get(runId) as { latest: number }
      const eventId = current.latest + 1

      this.db
        .prepare(
          'INSERT INTO events (run_id, event_id, event_type, event_data_json, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(runId, eventId, type, JSON.stringify(data), now)

      return {
        runId,
        eventId,
        type,
        data,
        createdAt: now,
      } satisfies RunEvent
    })

    return tx()
  }

  updateRunStatus(id: string, status: RunStatus, reason?: string | null): RunRecord {
    const now = new Date().toISOString()
    const finishedAt = status === 'running' || status === 'queued' ? null : now
    this.db
      .prepare(
        `UPDATE runs
         SET status = ?, reason = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
         WHERE id = ?`,
      )
      .run(status, reason ?? null, now, finishedAt, id)
    return this.getRunOrThrow(id)
  }

  markRunStarted(id: string): RunRecord {
    const now = new Date().toISOString()
    this.db
      .prepare('UPDATE runs SET status = ?, started_at = ?, updated_at = ? WHERE id = ?')
      .run('running', now, now, id)
    return this.getRunOrThrow(id)
  }

  setRunSession(id: string, sessionId: string): RunRecord {
    const now = new Date().toISOString()
    this.db
      .prepare('UPDATE runs SET session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, now, id)
    return this.getRunOrThrow(id)
  }

  requestCancel(id: string): RunRecord {
    const now = new Date().toISOString()
    this.db
      .prepare('UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE id = ?')
      .run(now, id)
    return this.getRunOrThrow(id)
  }

  updateBudgetUsage(id: string, tokenDelta: number, costDelta: number): RunRecord {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `UPDATE runs
         SET budget_tokens_used = budget_tokens_used + ?,
             budget_cost_used = budget_cost_used + ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(tokenDelta, costDelta, now, id)
    return this.getRunOrThrow(id)
  }

  upsertTask(task: AgentTask, status: string, retriesUsed: number): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, run_id, status, retries_used, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           status = excluded.status,
           retries_used = excluded.retries_used,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(task.taskId, task.runId, status, retriesUsed, JSON.stringify(task), now)
  }

  saveResult(result: AgentResult): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO results (result_id, run_id, task_id, agent_role, stage, status, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(result_id) DO UPDATE SET
          stage = excluded.stage,
          status = excluded.status,
          payload_json = excluded.payload_json`,
      )
      .run(
        result.resultId,
        result.runId,
        result.taskId,
        result.agentRole,
        result.stage,
        result.status,
        JSON.stringify(result),
        now,
      )

    for (const evidence of result.evidence) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO evidence
          (evidence_id, run_id, task_id, result_id, type, uri, hash, description, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidence.evidenceId,
          result.runId,
          result.taskId,
          result.resultId,
          evidence.type,
          evidence.uri,
          evidence.hash,
          evidence.description,
          JSON.stringify(evidence.metadata ?? {}),
          now,
        )
    }

    for (const artifact of result.artifacts) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO artifacts
          (artifact_id, run_id, task_id, result_id, kind, uri, size_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.artifactId,
          result.runId,
          result.taskId,
          result.resultId,
          artifact.kind,
          artifact.uri,
          artifact.sizeBytes ?? null,
          now,
        )
    }
  }

  getRunCounters(runId: string): {
    orchestratorIterations: number
    workersSpawned: number
    workerFailures: number
    evidenceItems: number
    latestEventId: number
  } {
    const orchestratorIterations =
      (this.db
        .prepare(
          "SELECT COUNT(*) AS total FROM events WHERE run_id = ? AND event_type = 'orchestrator.plan.completed'",
        )
        .get(runId) as { total: number }).total ?? 0

    const workersSpawned =
      (this.db
        .prepare("SELECT COUNT(*) AS total FROM tasks WHERE run_id = ?")
        .get(runId) as { total: number }).total ?? 0

    const workerFailures =
      (this.db
        .prepare("SELECT COUNT(*) AS total FROM tasks WHERE run_id = ? AND status = 'failed'")
        .get(runId) as { total: number }).total ?? 0

    const evidenceItems =
      (this.db
        .prepare('SELECT COUNT(*) AS total FROM evidence WHERE run_id = ?')
        .get(runId) as { total: number }).total ?? 0

    const latestEventId =
      (this.db
        .prepare('SELECT COALESCE(MAX(event_id), 0) AS latest FROM events WHERE run_id = ?')
        .get(runId) as { latest: number }).latest ?? 0

    return {
      orchestratorIterations,
      workersSpawned,
      workerFailures,
      evidenceItems,
      latestEventId,
    }
  }

  private mapRun(row: RunRow): RunRecord {
    return {
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      reason: row.reason,
      cancelRequested: Boolean(row.cancel_requested),
      sessionId: row.session_id,
      orchestrationPackage: JSON.parse(row.package_json) as OrchestrationPackage,
      budgetTokensUsed: row.budget_tokens_used,
      budgetCostUsed: row.budget_cost_used,
    }
  }

  listTasks(runId: string): Array<{
    taskId: string
    status: string
    retriesUsed: number
    updatedAt: string
    payload: Record<string, unknown>
  }> {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY updated_at DESC')
      .all(runId) as TaskRow[]

    return rows.map((row) => ({
      taskId: row.task_id,
      status: row.status,
      retriesUsed: row.retries_used,
      updatedAt: row.updated_at,
      payload: safeJson(row.payload_json),
    }))
  }

  listResults(runId: string, limit = 200): Array<{
    resultId: string
    taskId: string | null
    agentRole: string
    stage: string
    status: string
    createdAt: string
    payload: Record<string, unknown>
  }> {
    const rows = this.db
      .prepare('SELECT * FROM results WHERE run_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(runId, limit) as ResultRow[]

    return rows.map((row) => ({
      resultId: row.result_id,
      taskId: row.task_id,
      agentRole: row.agent_role,
      stage: row.stage,
      status: row.status,
      createdAt: row.created_at,
      payload: safeJson(row.payload_json),
    }))
  }

  listEvidence(runId: string, limit = 500): Array<{
    evidenceId: string
    taskId: string | null
    resultId: string | null
    type: string
    uri: string
    hash: string
    description: string
    metadata: Record<string, unknown>
    createdAt: string
  }> {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(runId, limit) as EvidenceRow[]

    return rows.map((row) => ({
      evidenceId: row.evidence_id,
      taskId: row.task_id,
      resultId: row.result_id,
      type: row.type,
      uri: row.uri,
      hash: row.hash,
      description: row.description,
      metadata: safeJson(row.metadata_json ?? '{}'),
      createdAt: row.created_at,
    }))
  }

  listArtifacts(runId: string, limit = 200): Array<{
    artifactId: string
    taskId: string | null
    resultId: string | null
    kind: string
    uri: string
    sizeBytes: number | null
    createdAt: string
  }> {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(runId, limit) as ArtifactRow[]

    return rows.map((row) => ({
      artifactId: row.artifact_id,
      taskId: row.task_id,
      resultId: row.result_id,
      kind: row.kind,
      uri: row.uri,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
    }))
  }
}

function safeJson(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { raw: input }
  }
}
