import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setRunStoppedListener } from '@/modules/notifications/index.js';
import { abortCursorSession, spawnCursor } from '@/modules/providers/list/cursor/cursor-runtime.provider.js';
import { abortOpenCodeSession, spawnOpenCode } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';

const runtimes = [
  { binary: 'cursor-agent', spawn: spawnCursor, abort: abortCursorSession },
  { binary: 'opencode', spawn: spawnOpenCode, abort: abortOpenCodeSession },
];

for (const { binary, spawn, abort } of runtimes) {
  test(`stopping ${binary} mid-run decides no stop or failed notice`, async () => {
    // A stand-in CLI that runs until it is killed.
    const bin = await mkdtemp(path.join(os.tmpdir(), 'cli-runtime-abort-'));
    await writeFile(path.join(bin, binary), '#!/bin/sh\nexec sleep 30\n');
    await chmod(path.join(bin, binary), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    const heard: Array<string | null> = [];
    setRunStoppedListener((sessionId) => { heard.push(sessionId); });

    try {
      const sessionId = `app-${binary}-abort`;
      const writer = { send: () => {}, userId: null };
      const context = { resolveProviderSessionId: () => null, resolveResumeModel: async () => undefined, isProviderInstalled: async () => true, getProviderModels: async () => [] };
      const run = spawn('hello', { sessionId, cwd: bin }, writer as never, context as never);
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      assert.equal(abort(sessionId), true);
      await assert.rejects(run);
      assert.deepEqual(heard, []);
    } finally {
      setRunStoppedListener(() => {});
      process.env.PATH = previousPath;
      await rm(bin, { recursive: true, force: true });
    }
  });
}
