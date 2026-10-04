import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scanStateDb, sessionsDb } from '@/modules/database/index.js';

// The watcher and the provider synchronizers resolve the home directory when
// they are first imported, so HOME must point at the fixture before that.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'claude-unclassified-home-'));
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.DATABASE_PATH = path.join(fixtureHome, 'auth.db');

const { closeSessionsWatcher, initializeSessionsWatcher } = await import(
  '@/modules/providers/services/sessions-watcher.service.js'
);

const workspacePath = path.join(fixtureHome, 'workspace');
const projectDirectory = path.join(fixtureHome, '.claude', 'projects', 'workspace');

async function writeTranscript(sessionId: string, aiTitle: string): Promise<string> {
  const filePath = path.join(projectDirectory, `${sessionId}.jsonl`);
  await writeFile(filePath, [
    { type: 'user', message: { role: 'user', content: 'first prompt' }, cwd: workspacePath },
    { type: 'ai-title', aiTitle },
  ].map((data) => `${JSON.stringify({ ...data, sessionId })}\n`).join(''), 'utf8');
  return filePath;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('startup re-syncs the names of Claude rows indexed before name_source, whatever their mtime', async () => {
  await initializeDatabase();

  try {
    await mkdir(projectDirectory, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await writeFile(
      path.join(fixtureHome, '.claude', 'history.jsonl'),
      `${JSON.stringify({ sessionId: 'history-named', display: '/model' })}\n`,
      'utf8',
    );
    const historyNamedPath = await writeTranscript('history-named', 'Newer AI title');
    const typedNamePath = await writeTranscript('typed-name', 'Some AI title');
    // Its directory is gone too, so the startup scan keeps the row.
    const missingPath = path.join(fixtureHome, 'gone', 'missing.jsonl');

    // Rows written without naming have a NULL name_source, like rows from
    // before the column existed.
    sessionsDb.createSession('history-named', 'claude', workspacePath, '/model', undefined, undefined, historyNamedPath);
    sessionsDb.createSession('typed-name', 'claude', workspacePath, 'Typed in the web UI', undefined, undefined, typedNamePath);
    sessionsDb.createSession('missing', 'claude', workspacePath, 'Missing transcript', undefined, undefined, missingPath);

    // Both transcripts are older than the last scan, so the startup scan skips them.
    const hourAgo = new Date(Date.now() - 3_600_000);
    await utimes(historyNamedPath, hourAgo, hourAgo);
    await utimes(typedNamePath, hourAgo, hourAgo);
    scanStateDb.updateLastScannedAt(new Date());

    await initializeSessionsWatcher();
    await waitFor(() => sessionsDb.getUnclassifiedClaudeTranscriptPaths().length <= 1);

    const historyNamed = sessionsDb.getSessionById('history-named');
    assert.equal(historyNamed?.custom_name, 'Newer AI title');
    assert.equal(historyNamed?.name_source, 'derived');

    const typedName = sessionsDb.getSessionById('typed-name');
    assert.equal(typedName?.custom_name, 'Typed in the web UI');
    assert.equal(typedName?.name_source, 'web');

    const missing = sessionsDb.getSessionById('missing');
    assert.equal(missing?.custom_name, 'Missing transcript');
    assert.equal(missing?.name_source, null);
    assert.deepEqual(sessionsDb.getUnclassifiedClaudeTranscriptPaths(), [missingPath]);
  } finally {
    await closeSessionsWatcher();
    closeConnection();
    await rm(fixtureHome, { recursive: true, force: true });
  }
});
