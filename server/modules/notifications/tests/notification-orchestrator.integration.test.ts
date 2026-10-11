import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  sessionsDb,
} from '@/modules/database/index.js';

import {
  buildNotificationPayload,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  setRunStoppedListener,
} from '../services/notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('notification payload uses the app session id for a provider session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'claude-native-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });

    assert.equal(payload.data.sessionId, 'app-session-1');
    assert.match(payload.data.tag, /app-session-1/);
  });
});

/** Gives user 1 the stop timing, with every event on and every channel off. */
function mockStopTiming(t: TestContext, stopTiming: 'everyTurn' | 'whenIdle'): void {
  t.mock.method(notificationPreferencesDb, 'getPreferences', () => ({
    channels: {},
    events: { actionRequired: true, stop: true, error: true, stopTiming },
  }) as never);
}

test('the run-stopped listener hears every decided stop, background-completed and failed notice', async (t) => {
  await withIsolatedDatabase(() => {
    const heard: unknown[] = [];
    setRunStoppedListener((sessionId: unknown) => { heard.push(sessionId); });
    try {
      // No user, and a repeat inside the dedupe window: both still count.
      notifyRunStopped({ userId: null, provider: 'claude', sessionId: 's-stop' });
      notifyRunStopped({ userId: null, provider: 'claude', sessionId: 's-stop' });
      notifyRunStopped({ userId: null, provider: 'claude', sessionId: 's-aborted', stopReason: 'aborted' });
      notifyRunFailed({ userId: null, provider: 'cursor', sessionId: 's-failed', error: 'boom' });
      assert.deepEqual(heard, ['s-stop', 's-stop', 's-failed']);

      heard.length = 0;
      mockStopTiming(t, 'whenIdle');
      notifyBackgroundWorkCompleted({ userId: 1, provider: 'claude', sessionId: 's-idle' });
      assert.deepEqual(heard, [], 'the held stop notice reports this work under whenIdle');

      t.mock.restoreAll();
      mockStopTiming(t, 'everyTurn');
      notifyBackgroundWorkCompleted({ userId: 1, provider: 'claude', sessionId: 's-every' });
      assert.deepEqual(heard, ['s-every']);
    } finally {
      setRunStoppedListener(() => {});
    }
  });
});
