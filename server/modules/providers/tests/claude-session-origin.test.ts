import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { getProjectsWithSessions } from '@/modules/projects/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { broadcastSessionUpserted, connectedClients } from '@/modules/websocket/index.js';

/**
 * Indexes two Claude transcripts, one started in a terminal and one started
 * by this app, and checks what the sidebar is told about each: the project
 * list and the `session_upserted` delta both say which one began outside the
 * app, and how.
 */
test('session payloads mark a terminal session external with its entrypoint, and an app session as app', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-origin-'));
  const workspacePath = path.join(tmp, 'workspace');
  await mkdir(path.join(tmp, '.claude'), { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(tmp, '.claude', 'history.jsonl'), '', 'utf8');

  const writeTranscript = async (sessionId: string, entrypoint: string) => {
    const filePath = path.join(workspacePath, `${sessionId}.jsonl`);
    const row = { type: 'user', sessionId, cwd: workspacePath, entrypoint, message: { role: 'user', content: 'hi' } };
    await writeFile(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    return filePath;
  };

  const originalHomedir = os.homedir;
  const previousDatabasePath = process.env.DATABASE_PATH;
  (os as any).homedir = () => tmp;
  closeConnection();
  process.env.DATABASE_PATH = path.join(tmp, 'auth.db');
  await initializeDatabase();

  try {
    const synchronizer = new ClaudeSessionSynchronizer();
    sessionsDb.createAppSession('app-1', 'claude', workspacePath, 'hi');
    sessionsDb.assignProviderSessionId('app-1', 'app-native');

    assert.equal(await synchronizer.synchronizeFile(await writeTranscript('terminal-session', 'cli')), 'terminal-session');
    assert.equal(await synchronizer.synchronizeFile(await writeTranscript('app-native', 'sdk-ts')), 'app-1');

    const [project] = await getProjectsWithSessions({ skipSynchronization: true });
    const listed = new Map(project.sessions.map((session) => [session.id, session]));
    assert.equal(listed.get('terminal-session')?.origin, 'external');
    assert.equal(listed.get('terminal-session')?.entrypoint, 'cli');
    assert.equal(listed.get('app-1')?.origin, 'app');

    const frames: Array<{ sessionId: string; session: { origin: string; entrypoint: string | null } }> = [];
    connectedClients.add({ readyState: 1, send: (data: string) => frames.push(JSON.parse(data)) } as never);
    await broadcastSessionUpserted('terminal-session');
    await broadcastSessionUpserted('app-native');
    assert.deepEqual(frames.map((frame) => [frame.sessionId, frame.session.origin, frame.session.entrypoint]), [
      ['terminal-session', 'external', 'cli'],
      ['app-1', 'app', 'sdk-ts'],
    ]);
  } finally {
    connectedClients.clear();
    closeConnection();
    (os as any).homedir = originalHomedir;
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

/**
 * Editing the first prompt of a session discovered from disk moves it off the
 * transcript whose id is its own app id. Indexing that transcript again must
 * neither hand the row back to it nor list it as a session of its own.
 */
test('the indexer skips a transcript a session was edited off', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-superseded-'));
  const workspacePath = path.join(tmp, 'workspace');
  const transcriptDirectory = path.join(tmp, '.claude', 'projects', 'workspace');
  await mkdir(transcriptDirectory, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(tmp, '.claude', 'history.jsonl'), '', 'utf8');
  const oldTranscript = path.join(transcriptDirectory, 'old-native.jsonl');
  const row = { type: 'user', sessionId: 'old-native', cwd: workspacePath, entrypoint: 'cli', message: { role: 'user', content: 'hi' } };
  await writeFile(oldTranscript, `${JSON.stringify(row)}\n`, 'utf8');

  const originalHomedir = os.homedir;
  const previousDatabasePath = process.env.DATABASE_PATH;
  (os as any).homedir = () => tmp;
  closeConnection();
  process.env.DATABASE_PATH = path.join(tmp, 'auth.db');
  await initializeDatabase();

  try {
    const synchronizer = new ClaudeSessionSynchronizer();
    assert.equal(await synchronizer.synchronizeFile(oldTranscript), 'old-native');

    // What the edit leaves behind once its run has recorded the new session.
    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: 'old-native',
      provider: 'claude',
      sessionId: 'old-native',
      jsonlPath: oldTranscript,
    });
    sessionsDb.detachProviderSession('old-native');
    sessionsDb.assignProviderSessionId('old-native', 'new-native');

    assert.equal(await synchronizer.synchronizeFile(oldTranscript), null);
    assert.equal(await synchronizer.synchronize(), 0);
    assert.equal(sessionsDb.getSessionById('old-native')?.provider_session_id, 'new-native');
    const [project] = await getProjectsWithSessions({ skipSynchronization: true });
    assert.deepEqual(project.sessions.map((session) => session.id), ['old-native']);
  } finally {
    closeConnection();
    (os as any).homedir = originalHomedir;
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
