import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { findFilesRecursivelyModifiedAfter } from '@/shared/utils.js';

const SESSION_ID = 'cli-session';

const line = (data: Record<string, unknown>) => `${JSON.stringify({ ...data, sessionId: SESSION_ID })}\n`;
const aiTitle = (title: string) => line({ type: 'ai-title', aiTitle: title });
const customTitle = (title: string) => line({ type: 'custom-title', customTitle: title });

/**
 * Runs one test against a fresh database and a fake home directory holding a
 * Claude transcript that starts with `initialLines`. `sync` re-indexes it.
 */
async function withTranscript(
  initialLines: string[],
  runTest: (ctx: {
    workspacePath: string;
    append: (...lines: string[]) => Promise<void>;
    sync: () => Promise<string | null>;
  }) => Promise<void>,
): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-naming-'));
  const workspacePath = path.join(tmp, 'workspace');
  const transcriptPath = path.join(workspacePath, `${SESSION_ID}.jsonl`);
  await mkdir(path.join(tmp, '.claude'), { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(tmp, '.claude', 'history.jsonl'), '', 'utf8');
  await writeFile(transcriptPath, [
    line({ type: 'user', message: { role: 'user', content: 'first prompt' }, cwd: workspacePath }),
    ...initialLines,
  ].join(''), 'utf8');

  const originalHomedir = os.homedir;
  const previousDatabasePath = process.env.DATABASE_PATH;
  (os as any).homedir = () => tmp;
  closeConnection();
  process.env.DATABASE_PATH = path.join(tmp, 'auth.db');
  await initializeDatabase();

  try {
    const synchronizer = new ClaudeSessionSynchronizer();
    await runTest({
      workspacePath,
      append: async (...lines) => appendFile(transcriptPath, lines.join(''), 'utf8'),
      sync: () => synchronizer.synchronizeFile(transcriptPath),
    });
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
}

const nameOf = (sessionId: string) => sessionsDb.getSessionById(sessionId)?.custom_name;

test('a CLI /rename after a session is indexed reaches its name', { concurrency: false }, async () => {
  await withTranscript([aiTitle('AI title')], async ({ append, sync }) => {
    const sessionId = await sync();
    assert.equal(nameOf(sessionId!), 'AI title');

    await append(customTitle('Renamed in the CLI'));
    assert.equal(await sync(), sessionId);
    assert.equal(nameOf(sessionId!), 'Renamed in the CLI');
  });
});

test('transcript titles replace a derived app name, a web rename holds until the next CLI rename', { concurrency: false }, async () => {
  await withTranscript([aiTitle('First AI title')], async ({ workspacePath, append, sync }) => {
    sessionsDb.createAppSession('app-1', 'claude', workspacePath, 'first prompt');
    sessionsDb.assignProviderSessionId('app-1', SESSION_ID);

    assert.equal(await sync(), 'app-1');
    assert.equal(nameOf('app-1'), 'First AI title');

    sessionsService.renameSessionById('app-1', 'Web name');
    await append(aiTitle('Second AI title'));
    await sync();
    assert.equal(nameOf('app-1'), 'Web name');

    await append(customTitle('CLI name'));
    await sync();
    assert.equal(nameOf('app-1'), 'CLI name');

    // The custom-title is unchanged, so the later web rename stands.
    sessionsService.renameSessionById('app-1', 'Web name again');
    await sync();
    assert.equal(nameOf('app-1'), 'Web name again');
  });
});

test('a new last-prompt keeps a derived name, a new ai-title replaces it', { concurrency: false }, async () => {
  const lastPrompt = (prompt: string) => line({ type: 'last-prompt', lastPrompt: prompt });
  await withTranscript([lastPrompt('fix the login bug in auth')], async ({ append, sync }) => {
    const sessionId = await sync();
    assert.equal(nameOf(sessionId!), 'fix the login bug in auth');

    await append(lastPrompt('try again'));
    await sync();
    assert.equal(nameOf(sessionId!), 'fix the login bug in auth');

    await append(aiTitle('Fix the auth login bug'));
    await sync();
    assert.equal(nameOf(sessionId!), 'Fix the auth login bug');
  });
});

test('a row from before name_source matching a transcript title is classified derived', { concurrency: false }, async () => {
  await withTranscript([aiTitle('AI title')], async ({ workspacePath, append, sync }) => {
    sessionsDb.createSession(SESSION_ID, 'claude', workspacePath, 'AI title');
    await append(aiTitle('Newer AI title'));
    await sync();

    const row = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(row?.custom_name, 'Newer AI title');
    assert.equal(row?.name_source, 'derived');
  });
});

test('a row from before name_source with any other name keeps it until a new CLI rename', { concurrency: false }, async () => {
  await withTranscript([customTitle('Old CLI title')], async ({ workspacePath, append, sync }) => {
    sessionsDb.createSession(SESSION_ID, 'claude', workspacePath, 'Typed in the web UI');
    await sync();

    const row = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(row?.custom_name, 'Typed in the web UI');
    assert.equal(row?.name_source, 'web');
    assert.equal(row?.last_custom_title, 'Old CLI title');

    await append(customTitle('New CLI title'));
    await sync();
    assert.equal(nameOf(SESSION_ID), 'New CLI title');
  });
});

test('the startup scan finds a transcript modified after the last scan', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-scan-mtime-'));
  try {
    const touched = path.join(tmp, 'touched.jsonl');
    const untouched = path.join(tmp, 'untouched.jsonl');
    await writeFile(touched, '{}\n');
    await writeFile(untouched, '{}\n');

    // Both files were created before the scan; only one is written after it.
    const lastScanAt = new Date(Date.now() + 60_000);
    const later = new Date(lastScanAt.getTime() + 60_000);
    await utimes(touched, later, later);

    assert.deepEqual(await findFilesRecursivelyModifiedAfter(tmp, '.jsonl', lastScanAt), [touched]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
