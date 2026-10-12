import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Db = Database.Database;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS kv (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS oauth_clients (
     client_id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS auth_codes (
     code_hash TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     data TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS tokens (
     token_hash TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
     client_id TEXT NOT NULL,
     scopes TEXT NOT NULL,
     resource TEXT,
     expires_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS tokens_client ON tokens(client_id);
   CREATE TABLE IF NOT EXISTS audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     actor TEXT NOT NULL,
     tool TEXT NOT NULL,
     args TEXT NOT NULL,
     outcome TEXT NOT NULL,
     detail TEXT
   );`,
];

export function openDb(dataDir: string, filename = 'app.db'): Db {
  let db: Db;
  if (dataDir === ':memory:') {
    db = new Database(':memory:');
  } else {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, filename));
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]!);
    db.pragma(`user_version = ${i + 1}`);
  }
  return db;
}

export class KvStore {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
}

export interface AuditEntry {
  actor: string;
  tool: string;
  args: unknown;
  outcome: 'ok' | 'error';
  detail?: string;
}

export class AuditLog {
  constructor(private readonly db: Db | undefined) {}

  record(entry: AuditEntry): void {
    const line = { ts: new Date().toISOString(), ...entry };
    // Always mirror to stderr so container logs carry the audit trail (stdout is reserved for stdio MCP).
    console.error(`[audit] ${JSON.stringify(line)}`);
    this.db
      ?.prepare(
        'INSERT INTO audit_log (ts, actor, tool, args, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        Date.now(),
        entry.actor,
        entry.tool,
        JSON.stringify(entry.args ?? {}),
        entry.outcome,
        entry.detail ?? null,
      );
  }

  recent(
    limit = 50,
  ): Array<{ ts: number; actor: string; tool: string; outcome: string; detail: string | null }> {
    return this.db
      ? (this.db
          .prepare(
            'SELECT ts, actor, tool, outcome, detail FROM audit_log ORDER BY id DESC LIMIT ?',
          )
          .all(limit) as Array<{
          ts: number;
          actor: string;
          tool: string;
          outcome: string;
          detail: string | null;
        }>)
      : [];
  }
}
