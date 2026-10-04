import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import type { SessionOrigin } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

/**
 * Who last set a session's name, stored in `sessions.name_source`. Used by the
 * Claude synchronizer to decide whether transcript titles may replace it.
 *
 * `web` is a rename in this app, `cli` is a `/rename` in the CLI (a transcript
 * `custom-title`), and `derived` is a name the app or a synchronizer computed.
 * NULL in the database marks a row from before the column existed.
 */
export type SessionNameSource = 'web' | 'cli' | 'derived';

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  // Optional because only the Claude synchronizer reads them; every row read
  // from the database carries both.
  /** Who last set `custom_name`; NULL on rows that predate the column. */
  name_source?: SessionNameSource | null;
  /** The last transcript `custom-title` a synchronizer applied or recorded. */
  last_custom_title?: string | null;
  /** Model this session runs with; NULL until the app records one for it. */
  model: string | null;
  /** Reasoning effort this session runs with; NULL until the app records one. */
  effort: string | null;
  /** The app session this one was branched from; NULL unless it is a fork. */
  forked_from_session_id: string | null;
  // Optional so test stubs need not carry them; every row read from the
  // database does.
  /** How the provider CLI was started, from the transcript; NULL when unknown. */
  entrypoint?: string | null;
  /** Not a column: derived from the two ids when the row is read. */
  origin?: SessionOrigin;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type RecentSessionsPage = {
  sessions: SessionRow[];
  total: number;
};

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, name_source, last_custom_title, model, effort, forked_from_session_id, entrypoint, isArchived, created_at, updated_at';

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    // A row the app created has its own id; one indexed from disk reuses the provider's.
    origin: row.provider_session_id && row.provider_session_id === row.session_id ? 'external' : 'app',
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row. An
   * app-created row keeps its existing name; synchronizer names only update
   * rows that were themselves created by indexing provider storage.
   *
   * Passing `naming` means the synchronizer has already decided the name
   * against the row's `name_source`: `customName` is then written as given,
   * on app-created rows too, along with both naming columns.
   *
   * `entrypoint` is how the transcript says its CLI was started; a NULL keeps
   * the stored one.
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null,
    naming?: { nameSource: SessionNameSource; lastCustomTitle: string | null },
    entrypoint?: string | null
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    const existing = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { session_id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE sessions SET
           provider = ?,
           updated_at = COALESCE(?, CURRENT_TIMESTAMP),
           project_path = ?,
           jsonl_path = ?,
           isArchived = CASE WHEN ? IS NULL OR julianday(?) > julianday(updated_at) THEN 0 ELSE isArchived END,
           custom_name = CASE
             WHEN ? IS NOT NULL THEN ?
             WHEN session_id <> provider_session_id AND custom_name IS NOT NULL THEN custom_name
             ELSE COALESCE(?, custom_name)
           END,
           name_source = COALESCE(?, name_source),
           last_custom_title = CASE WHEN ? IS NOT NULL THEN ? ELSE last_custom_title END,
           entrypoint = COALESCE(?, entrypoint)
         WHERE session_id = ?`
      ).run(
        provider,
        updatedAtValue,
        normalizedProjectPath,
        jsonlPath ?? null,
        updatedAtValue,
        updatedAtValue,
        naming?.nameSource ?? null,
        customName ?? null,
        customName ?? null,
        naming?.nameSource ?? null,
        naming?.nameSource ?? null,
        naming?.lastCustomTitle ?? null,
        entrypoint ?? null,
        existing.session_id
      );

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, name_source, last_custom_title, entrypoint, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         isArchived = CASE WHEN ? IS NULL OR julianday(excluded.updated_at) > julianday(sessions.updated_at) THEN 0 ELSE sessions.isArchived END,
         custom_name = CASE
           WHEN excluded.name_source IS NOT NULL THEN excluded.custom_name
           WHEN sessions.session_id <> sessions.provider_session_id AND sessions.custom_name IS NOT NULL
             THEN sessions.custom_name
           ELSE COALESCE(excluded.custom_name, sessions.custom_name)
         END,
         name_source = COALESCE(excluded.name_source, sessions.name_source),
         last_custom_title = CASE
           WHEN excluded.name_source IS NOT NULL THEN excluded.last_custom_title
           ELSE sessions.last_custom_title
         END,
         entrypoint = COALESCE(excluded.entrypoint, sessions.entrypoint)`
    ).run(
      providerSessionId,
      provider,
      providerSessionId,
      customName ?? null,
      naming?.nameSource ?? null,
      naming?.lastCustomTitle ?? null,
      entrypoint ?? null,
      normalizedProjectPath,
      jsonlPath ?? null,
      createdAtValue,
      updatedAtValue,
      updatedAtValue
    );

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping. `customName` is derived
   * from the first visible CloudCLI message by the sessions service, so the
   * row starts as `derived` and transcript titles may replace it.
   */
  createAppSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
  ): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, name_source, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'derived', ?, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(sessionId, provider, customName ?? null, normalizedProjectPath);

    return sessionId;
  },

  /**
   * Inserts a session that already has its provider artifact on disk.
   *
   * Unlike `createAppSession` this writes `provider_session_id` and
   * `jsonl_path` immediately, because a fork's transcript file exists before
   * the row does — and the filesystem watcher would otherwise index it as an
   * unrelated session under its own id.
   */
  createForkedSession(input: {
    sessionId: string;
    provider: string;
    projectPath: string;
    customName: string | null;
    providerSessionId: string;
    jsonlPath: string;
    forkedFromSessionId: string;
    model: string | null;
    effort: string | null;
  }): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(input.provider, input.projectPath);

    projectsDb.createProjectPath(normalizedProjectPath);

    // The watcher may already have created a row for the new transcript. Its
    // id is the provider-native one, which is what this row claims, so replace
    // it rather than leaving two sidebar entries for one conversation.
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?')
        .run(input.providerSessionId, input.sessionId);
      db.prepare(
        `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, name_source, project_path, jsonl_path, model, effort, forked_from_session_id, isArchived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'derived', ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).run(
        input.sessionId,
        input.provider,
        input.providerSessionId,
        input.customName,
        normalizedProjectPath,
        input.jsonlPath,
        input.model,
        input.effort,
        input.forkedFromSessionId,
      );
    })();

    return input.sessionId;
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path is adopted,
   * its name only when the app row has none (the naming columns travel with
   * the name), and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): void {
    const db = getConnection();

    const merge = db.transaction(() => {
      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             custom_name = COALESCE(custom_name, ?),
             name_source = CASE WHEN custom_name IS NULL THEN ? ELSE name_source END,
             last_custom_title = CASE WHEN custom_name IS NULL THEN ? ELSE last_custom_title END,
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        ).run(
          providerSessionId,
          duplicate.jsonl_path,
          duplicate.custom_name,
          duplicate.name_source ?? null,
          duplicate.last_custom_title ?? null,
          sessionId,
        );
        return;
      }

      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(providerSessionId, sessionId);
    });

    merge();
  },

  /**
   * Moves one session onto a different provider session and transcript.
   *
   * Only editing a message on a provider that has to branch to rewind (Codex)
   * does this — an ordinary run keeps the same provider session for its whole
   * life. `assignProviderSessionId` cannot be used for it: that one keeps the
   * existing `jsonl_path` on purpose, so a session repointed with it would
   * claim the new thread while still reading the old transcript.
   *
   * The watcher may already have indexed the new transcript under its own id.
   * That row is the same conversation this one is about to become, so it is
   * replaced rather than left behind as a second sidebar entry.
   */
  repointSessionToProviderSession(
    sessionId: string,
    input: { providerSessionId: string; jsonlPath: string },
  ): void {
    const db = getConnection();

    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?')
        .run(input.providerSessionId, sessionId);
      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           jsonl_path = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(input.providerSessionId, input.jsonlPath, sessionId);
    })();
  },

  /**
   * Detaches a session from its provider session so the next run starts a new
   * one.
   *
   * Used when an edit replaces the very first prompt: there is no conversation
   * left to branch from, so the session starts over instead.
   */
  detachProviderSession(sessionId: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions SET
         provider_session_id = NULL,
         jsonl_path = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ?`
    ).run(sessionId);
  },

  /**
   * Records that a session has left a provider session behind for good.
   *
   * The transcript stays on disk, which is deliberate — the abandoned attempt
   * is recoverable — but the indexer must not offer it back, and on a session
   * discovered from disk (whose app id *is* the provider id) rediscovering it
   * would repoint the row at the conversation the user edited away from.
   */
  markProviderSessionSuperseded(input: {
    providerSessionId: string;
    provider: string;
    sessionId: string;
    jsonlPath: string | null;
  }): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO superseded_provider_sessions (provider_session_id, provider, session_id, jsonl_path)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_session_id, provider) DO UPDATE SET
         session_id = excluded.session_id,
         jsonl_path = excluded.jsonl_path,
         created_at = CURRENT_TIMESTAMP`
    ).run(input.providerSessionId, input.provider, input.sessionId, input.jsonlPath);
  },

  isProviderSessionSuperseded(providerSessionId: string, provider: string): boolean {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT 1 AS found FROM superseded_provider_sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { found: number } | undefined;

    return Boolean(row);
  },

  /**
   * Transcripts one session has left behind, for the caller that deletes a
   * conversation from disk.
   *
   * A conversation edited more than once has lived in more than one file, and
   * the session row only ever points at the newest.
   */
  getSupersededTranscriptPaths(sessionId: string): string[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT jsonl_path FROM superseded_provider_sessions
         WHERE session_id = ? AND jsonl_path IS NOT NULL`
      )
      .all(sessionId) as Array<{ jsonl_path: string }>;

    return rows.map((row) => row.jsonl_path);
  },

  /**
   * Forgets what a session left behind, once the session itself is gone.
   *
   * Without this the record outlives the row it was written for and keeps the
   * indexer refusing a transcript that no longer belongs to anything — a
   * conversation invisible to the app and impossible to delete through it.
   */
  clearSupersededProviderSessions(sessionId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM superseded_provider_sessions WHERE session_id = ?').run(sessionId);
  },

  /**
   * Records the model one session runs with.
   *
   * Called both when the user picks a model for the session and on every send,
   * so the row always reflects what the session last ran with and reopening it
   * restores that model instead of a catalog default.
   */
  setSessionModel(sessionId: string, model: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET model = ?
       WHERE session_id = ?`
    ).run(model, sessionId);
  },

  /**
   * Records the reasoning effort one session runs with.
   *
   * `default` is stored as an explicit choice rather than NULL so reopening
   * the session does not inherit a later per-provider effort preference.
   */
  setSessionEffort(sessionId: string, effort: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET effort = ?
       WHERE session_id = ?`
    ).run(effort, sessionId);
  },

  /**
   * Renames one session as the user's own choice: the name becomes `web`, so
   * transcript titles no longer replace it until a newer CLI `/rename`.
   */
  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?, name_source = 'web'
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  findLatestPendingAppSession(provider: string, projectPath: string): SessionRow | null {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`
      )
      .get(provider, normalizedProjectPath) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Returns one globally ordered page of visible conversations.
   *
   * Pagination happens after archived sessions and sessions belonging to an
   * archived project have been excluded. This keeps the sidebar feed complete
   * and correctly ordered across projects instead of flattening only the
   * per-project slices already loaded by the client.
   */
  getRecentSessionsPage(limit: number, offset: number): RecentSessionsPage {
    const db = getConnection();
    const visibilityClause = `
      sessions.isArchived = 0
      AND (projects.isArchived IS NULL OR projects.isArchived = 0)
    `;
    const rows = db
      .prepare(
        `SELECT sessions.*
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}
         ORDER BY julianday(COALESCE(sessions.updated_at, sessions.created_at)) DESC,
                  sessions.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as SessionRow[];
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}`
      )
      .get() as { count: number } | undefined;

    return {
      sessions: normalizeSessionRows(rows),
      total: Number(countRow?.count ?? 0),
    };
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },

  /** Used by the OpenCode synchronizer to remove indexed child sessions by their native id. */
  deleteSessionByProviderSessionId(providerSessionId: string, provider: string): boolean {
    const db = getConnection();
    return db
      .prepare('DELETE FROM sessions WHERE provider_session_id = ? AND provider = ?')
      .run(providerSessionId, provider).changes > 0;
  },

  /**
   * Lists every indexed session that claims a transcript file on disk.
   *
   * Only rows with a `jsonl_path` are returned, which deliberately excludes
   * app-created sessions still waiting for their first provider write and
   * OpenCode rows (whose transcripts all live inside one shared sqlite file).
   * Used by the session synchronizer to find rows whose transcript has been
   * deleted underneath the index.
   */
  getSessionsWithTranscriptPath(): Array<{ session_id: string; jsonl_path: string }> {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, jsonl_path
         FROM sessions
         WHERE jsonl_path IS NOT NULL AND jsonl_path <> ''`
      )
      .all() as Array<{ session_id: string; jsonl_path: string }>;
  },

  /**
   * Transcript paths of the Claude rows indexed before `name_source` existed.
   * The session synchronizer re-syncs them once after startup, which
   * classifies each name and so removes the row from this list.
   */
  getUnclassifiedClaudeTranscriptPaths(): string[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT jsonl_path
         FROM sessions
         WHERE provider = 'claude' AND name_source IS NULL
           AND jsonl_path IS NOT NULL AND jsonl_path <> ''`
      )
      .all() as Array<{ jsonl_path: string }>;

    return rows.map((row) => row.jsonl_path);
  },
};
