import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Tests point DATABASE_PATH at a temporary database before their first query;
// a module that opens the connection on import would open the earlier path.
test('importing the notifications module opens no database', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notifications-import-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');
  process.env.DATABASE_PATH = databasePath;

  try {
    await import('@/modules/notifications/index.js');
    assert.equal(existsSync(databasePath), false);
  } finally {
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
