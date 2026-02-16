import Database from 'better-sqlite3'

export type OrchestrateDb = Database.Database

export function createDb(databasePath: string): OrchestrateDb {
  const db = new Database(databasePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      reason TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      package_json TEXT NOT NULL,
      budget_tokens_used INTEGER NOT NULL DEFAULT 0,
      budget_cost_used REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, event_id),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      retries_used INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS results (
      result_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT,
      agent_role TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS evidence (
      evidence_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT,
      result_id TEXT,
      type TEXT NOT NULL,
      uri TEXT NOT NULL,
      hash TEXT NOT NULL,
      description TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT,
      result_id TEXT,
      kind TEXT NOT NULL,
      uri TEXT NOT NULL,
      size_bytes INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
  `)

  return db
}
