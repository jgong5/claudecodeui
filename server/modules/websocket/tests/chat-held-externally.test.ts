import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'held-session';
const NATIVE_ID = 'claude-native-held';

/**
 * Runs `runTest` with the session in the database and, when `held`, a live
 * Claude CLI registry entry on it: `process.pid` is the one pid guaranteed to
 * be alive, and no `procStart` keeps the fixture portable.
 */
async function withSession(
  held: boolean,
  runTest: (runs: string[]) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-held-externally-'));
  const registryDirectory = path.join(tempDirectory, '.claude', 'sessions');
  await mkdir(registryDirectory, { recursive: true });
  if (held) {
    await writeFile(
      path.join(registryDirectory, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: NATIVE_ID, status: 'idle', startedAt: 1_000 }),
      'utf8',
    );
  }

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => tempDirectory;

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    sessionsDb.assignProviderSessionId(SESSION_ID, NATIVE_ID);
    await runTest([]);
  } finally {
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function createRuntime(runs: string[]) {
  return {
    hasRuntime: () => true,
    acceptsLiveInput: () => false,
    run: async (_provider: string, command: string) => {
      runs.push(command);
    },
  } as never;
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

function sendFrame(runs: string[]) {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: createRuntime(runs) });
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'hello' }));
  return socket;
}

test('a chat.send to a session another Claude process holds is refused and starts no run', async () => {
  await withSession(true, async (runs) => {
    const socket = sendFrame(runs);
    await settle();

    assert.deepEqual(runs, []);
    assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined);
    const refusal = socket.frames.find((frame) => frame.kind === 'protocol_error');
    assert.equal(refusal?.code, 'SESSION_HELD_EXTERNALLY');
    assert.equal(refusal?.sessionId, SESSION_ID);
  });
});

test('the same chat.send runs once no other process holds the session', async () => {
  await withSession(false, async (runs) => {
    const socket = sendFrame(runs);
    await settle();

    assert.deepEqual(runs, ['hello']);
    assert.equal(socket.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});

test('a detached turn on a held session is refused with a code its caller can retry on', async () => {
  await withSession(true, async (runs) => {
    const result = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'scheduled', interruptActiveRun: true },
      { runtime: createRuntime(runs) },
    );

    assert.equal(result.started, false);
    assert.equal(result.code, 'SESSION_HELD_EXTERNALLY');
    assert.deepEqual(runs, []);
  });
});
