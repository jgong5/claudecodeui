import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider, listScheduledPrompts } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { BackgroundTaskSummary } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('provider session id returns the mapped native id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-id', 'codex', '/tmp/session-id-copy-project');
    sessionsDb.assignProviderSessionId('app-session-id', 'codex-native-session-id');

    assert.equal(sessionsService.getProviderSessionId('app-session-id'), 'codex-native-session-id');
  });
});

test('app session names use at most four whole words from the initial message', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession(
      'codex',
      '/tmp/session-name-project',
      '  supercalifragilisticexpialidocious\nsecond   third fourth fifth  ',
    );

    assert.equal(result.sessionName, 'supercalifragilisticexpialidocious second third fourth');
    assert.equal(
      sessionsDb.getSessionById(result.sessionId)?.custom_name,
      'supercalifragilisticexpialidocious second third fourth',
    );
  });
});

test('app sessions without message text receive a stable fallback name', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession('claude', '/tmp/attachment-only-project', '  \n ');

    assert.equal(result.sessionName, 'Untitled Session');
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.custom_name, 'Untitled Session');
  });
});

test('provider session id is unavailable until the provider assigns one', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('pending-app-session', 'claude', '/tmp/session-id-copy-project');

    assert.throws(
      () => sessionsService.getProviderSessionId('pending-app-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'PROVIDER_SESSION_ID_NOT_AVAILABLE' && typedError.statusCode === 409;
      },
    );
  });
});

test('provider session id reports a missing app session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getProviderSessionId('missing-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_NOT_FOUND' && typedError.statusCode === 404;
      },
    );
  });
});

test('recent sessions map project metadata and preserve database pagination', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'older-session',
      'claude',
      '/tmp/recent-project',
      'Older conversation',
      '2026-08-01T08:00:00.000Z',
      '2026-08-01T09:00:00.000Z',
    );
    sessionsDb.createSession(
      'newer-session',
      'codex',
      '/tmp/recent-project',
      'Newer conversation',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T11:00:00.000Z',
    );
    projectsDb.updateCustomProjectName('/tmp/recent-project', 'Recent Project');

    const project = projectsDb.getProjectPath('/tmp/recent-project');
    const page = sessionsService.listRecentSessions(1, 0);

    assert.deepEqual(page, {
      conversations: [{
        sessionId: 'newer-session',
        provider: 'codex',
        projectId: project?.project_id ?? null,
        projectDisplayName: 'Recent Project',
        sessionTitle: 'Newer conversation',
        lastActivity: '2026-08-01T11:00:00.000Z',
        attention: null,
      }],
      total: 2,
      hasMore: true,
    });
  });
});

/** One Claude transcript row of user or assistant text, linked by uuid chain. */
function claudeTextRow(
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
  ordinal: number,
): Record<string, unknown> {
  return {
    type: role,
    uuid: `row-${ordinal}`,
    parentUuid: ordinal === 0 ? null : `row-${ordinal - 1}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
    sessionId,
    message: { role, content: [{ type: 'text', text }] },
  };
}

test('history pages are sliced from the cached full transcript and see appended rows', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-history-'));
  const sessionId = 'claude-history-cache-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      const rows = [
        claudeTextRow(sessionId, 'user', 'one', 0),
        claudeTextRow(sessionId, 'assistant', 'reply one', 1),
        claudeTextRow(sessionId, 'user', 'two', 2),
        claudeTextRow(sessionId, 'assistant', 'reply two', 3),
      ];
      await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      sessionsDb.createSession(
        sessionId,
        'claude',
        '/tmp/history-cache-project',
        'History cache conversation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:10.000Z',
        transcriptPath,
      );

      const page = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(page.total, 4);
      assert.equal(page.hasMore, true);
      assert.deepEqual(page.messages.map((message) => message.content), ['two', 'reply two']);

      // A row appended after the page was cached must appear on the next read.
      await appendFile(
        transcriptPath,
        `${JSON.stringify(claudeTextRow(sessionId, 'user', 'three', 4))}\n`,
        'utf8',
      );
      const refreshed = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(refreshed.total, 5);
      assert.deepEqual(refreshed.messages.map((message) => message.content), ['reply two', 'three']);

      // An older page keeps the tail-offset contract while served from cache.
      const older = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 2 });
      assert.deepEqual(older.messages.map((message) => message.content), ['reply one', 'two']);
      assert.equal(older.hasMore, true);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

/**
 * Stands in for the provider registry with one provider per id, each with the
 * runtime given — the seam through which a runtime's background work reaches
 * the running-sessions list without an SDK run behind it.
 */
async function withProviders(
  runtimes: Partial<Record<'claude' | 'codex', IProvider['runtime']>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const realListProviders = providerRegistry.listProviders;
  providerRegistry.listProviders = () =>
    Object.entries(runtimes).map(([id, runtime]) => ({ id, runtime }) as IProvider);
  try {
    await runTest();
  } finally {
    providerRegistry.listProviders = realListProviders;
    chatRunRegistry.clearAll();
  }
}

/**
 * Runs `runTest` against a Claude CLI process registry containing exactly
 * `records`, so the running-sessions tests never read the developer's real
 * `~/.claude/sessions`.
 */
async function withClaudeCliRegistry(
  records: Array<Record<string, unknown>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-registry-'));
  await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
  for (const record of records) {
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', `${record.pid}.json`),
      JSON.stringify(record),
      'utf8',
    );
  }

  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDirectory;
  try {
    await runTest();
  } finally {
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

const task = (taskId: string, startedAt: number): BackgroundTaskSummary => ({
  taskId,
  toolUseId: `toolu_${taskId}`,
  taskType: 'local_agent',
  description: `Task ${taskId}`,
  startedAt,
});

test('running sessions list a session whose background work outlived its turn', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('held-session', 'claude', '/tmp/running-project');
    // The turn ran and completed: the registry still holds the finished run.
    const run = chatRunRegistry.startRun({
      appSessionId: 'held-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);
    run.writer.send({ kind: 'text', content: 'launched', sessionId: 'held-session', provider: 'claude' });
    run.writer.sendComplete({ exitCode: 0 });
    assert.equal(run.status, 'completed');

    const tasks = [task('late', 2_000), task('early', 1_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      { claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'held-session', tasks }] } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'held-session',
          provider: 'claude',
          startedAt: 1_000,
          lastSeq: run.lastSeq,
          background: true,
          canInterrupt: false,
          tasks,
        }]);
        assert.ok(run.lastSeq > 0, 'the finished run still reports its sequence for replay');
      },
    ));
  });
});

test('a process held with no tracked task is listed from its own start time', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('cron-session', 'claude', '/tmp/running-project');
    const crons = [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' }];

    await withClaudeCliRegistry([], async () => await withProviders(
      // Held only for a cron job: no task to date it by, so the process start.
      { claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'cron-session', startedAt: 1_234, tasks: [], crons }] } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'cron-session',
          provider: 'claude',
          startedAt: 1_234,
          lastSeq: 0,
          background: true,
          canInterrupt: false,
          tasks: [],
          crons,
        }]);
      },
    ));
  });
});

test('running sessions carry their tasks on a chat run that is still going', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('busy-session', 'claude', '/tmp/running-project');
    sessionsDb.createAppSession('idle-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'busy-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    const tasks = [task('agent', 5_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      {
        claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'busy-session', tasks }] },
        // A runtime without background work contributes chat runs alone.
        codex: { run: async () => undefined, abort: () => false },
      },
      async () => {
        const sessions = await sessionsService.listRunningSessions();
        assert.equal(sessions.length, 1, 'a session with a running chat run is listed once');
        assert.deepEqual(sessions[0], {
          sessionId: 'busy-session',
          provider: 'claude',
          startedAt: run.startedAt,
          lastSeq: 0,
          tasks,
        });
      },
    ));
  });
});

test('running sessions with no background work are the chat runs alone', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('plain-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'plain-session', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry([], async () => await withProviders(
      { codex: { run: async () => undefined, abort: () => false } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'plain-session', provider: 'codex', startedAt: run.startedAt, lastSeq: 0,
        }]);
      },
    ));
  });
});

test('running sessions report a turn driven by the Claude CLI', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('cli-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('cli-session', 'claude-native-1');

    // `process.pid` is the one pid guaranteed to be alive; omitting procStart
    // keeps the fixture portable, since the start-time cross-check is Linux-only.
    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-1', status: 'busy', entrypoint: 'cli', startedAt: 4_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), [{
            sessionId: 'cli-session',
            provider: 'claude',
            startedAt: 4_000,
            lastSeq: 0,
            canInterrupt: false,
            external: true,
            statusText: 'Running in the Claude CLI',
          }]);
        },
      ),
    );
  });
});

test('running sessions ignore registry files a crash left behind and list idle live ones', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('stale-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('stale-session', 'claude-native-stale');
    sessionsDb.createAppSession('idle-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('idle-session', 'claude-native-idle');

    await withClaudeCliRegistry(
      [
        // The process is gone: signal 0 cannot find this pid.
        { pid: 4_194_302, sessionId: 'claude-native-stale', status: 'busy', startedAt: 1_000 },
        // Alive, but waiting for input: its turn has ended, its background
        // work may not have.
        { pid: process.pid, sessionId: 'claude-native-idle', status: 'idle', startedAt: 2_000 },
      ],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), [{
            sessionId: 'idle-session',
            provider: 'claude',
            startedAt: 2_000,
            lastSeq: 0,
            canInterrupt: false,
            external: true,
            background: true,
          }]);
        },
      ),
    );
  });
});

test('a CLI turn does not duplicate a session already running a chat run', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('both-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('both-session', 'claude-native-both');
    const run = chatRunRegistry.startRun({
      appSessionId: 'both-session', provider: 'claude', providerSessionId: 'claude-native-both', connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-both', status: 'busy', startedAt: 3_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          const sessions = await sessionsService.listRunningSessions();
          assert.equal(sessions.length, 1, 'the chat run already covers this session');
          assert.equal(sessions[0].canInterrupt, undefined, 'the interruptible chat run entry wins');
        },
      ),
    );
  });
});

test('an unreadable registry never fails the running-sessions poll', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('safe-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('safe-session', 'claude-native-safe');

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-safe', status: 'busy', startedAt: 5_000 }],
      async () => {
        // A half-written file sits alongside the good one; it must be skipped
        // rather than abort the whole poll.
        await writeFile(path.join(os.homedir(), '.claude', 'sessions', 'broken.json'), '{"pid":', 'utf8');
        await withProviders(
          { claude: { run: async () => undefined, abort: () => false } },
          async () => {
            const sessions = await sessionsService.listRunningSessions();
            assert.deepEqual(sessions.map((session) => session.sessionId), ['safe-session']);
          },
        );
      },
    );
  });
});

test('a live registry entry does not duplicate a session the runtime holds for background work', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('held-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('held-session', 'claude-native-held');
    const tasks = [task('agent', 1_000)];

    // The runtime's own process writes a registry entry too, busy while it
    // answers a task's notification in a turn of its own.
    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-held', status: 'busy', startedAt: 500 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'held-session', tasks }] } },
        async () => {
          const sessions = await sessionsService.listRunningSessions();
          assert.equal(sessions.length, 1, 'the runtime\'s entry covers this session');
          assert.equal(sessions[0].external, undefined);
          assert.deepEqual(sessions[0].tasks, tasks);
        },
      ),
    );
  });
});

test('an idle external process with an unreported background Bash reads as running work', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'external-session-'));
  const sessionId = 'claude-native-external';
  const processStartedAt = Date.parse('2026-10-03T10:00:00.000Z');
  // A launch row: the call, then the acknowledgement carrying `toolUseResult`.
  const launch = (toolUseId: string, name: string, at: string, toolUseResult: Record<string, unknown>) => [
    {
      type: 'assistant', uuid: `${toolUseId}-call`, sessionId, timestamp: at,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input: { description: name } }] },
    },
    {
      type: 'user', uuid: `${toolUseId}-ack`, sessionId, timestamp: at,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `${name} started` }] },
      toolUseResult,
    },
  ];
  const rows = [
    // Launched by an earlier process of the same session, which has exited.
    ...launch('toolu_old_monitor', 'Monitor', '2026-10-03T09:00:00.000Z', { taskId: 'bold0001', timeoutMs: 300_000, persistent: false }),
    // Launched by the live external process, and not reported yet.
    ...launch('toolu_bash', 'Bash', '2026-10-03T10:05:00.000Z', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bnew0001' }),
  ];
  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  try {
    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', projectDirectory, 'External session', now, now, transcriptPath);

      await withClaudeCliRegistry(
        [{ pid: process.pid, sessionId, status: 'idle', startedAt: processStartedAt }],
        async () => await withProviders(
          { claude: { run: async () => undefined, abort: () => false } },
          async () => {
            assert.deepEqual(await sessionsService.listRunningSessions(), [{
              sessionId,
              provider: 'claude',
              startedAt: processStartedAt,
              lastSeq: 0,
              canInterrupt: false,
              external: true,
              background: true,
            }]);

            const history = await new ClaudeSessionsProvider().fetchHistory(sessionId, { providerSessionId: sessionId });
            const statusOf = (toolId: string) => history.messages
              .find((message) => message.kind === 'tool_use' && message.toolId === toolId)?.backgroundStatus;
            assert.equal(statusOf('toolu_bash'), 'running');
            assert.equal(statusOf('toolu_old_monitor'), 'stopped');
          },
        ),
      );
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

/** A tool call and its result as the CLI writes them, `toolUseResult` beside the result. */
const toolCallRows = (
  sessionId: string,
  toolUseId: string,
  name: string,
  at: number,
  input: Record<string, unknown>,
  toolUseResult: Record<string, unknown>,
) => [
  {
    type: 'assistant', uuid: `${toolUseId}-call`, sessionId, timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input }] },
  },
  {
    type: 'user', uuid: `${toolUseId}-result`, sessionId, timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `${name} done` }] },
    toolUseResult,
  },
];

test('an idle external process lists the prompts its transcript still has scheduled', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'external-crons-'));
  const sessionId = 'claude-native-external-crons';
  const minute = 60_000;
  const processStartedAt = Date.now() - 60 * minute;
  const cronCreate = (id: string, at: number) => toolCallRows(
    sessionId, `toolu_create_${id}`, 'CronCreate', at,
    { cron: '7 * * * *', prompt: `run ${id}`, recurring: true, durable: false },
    { id, humanSchedule: 'Every hour', recurring: true, durable: false },
  );
  const wakeup = (toolUseId: string, at: number, scheduledFor: number) => toolCallRows(
    sessionId, toolUseId, 'ScheduleWakeup', at,
    { delaySeconds: 60, prompt: `wake ${toolUseId}`, reason: 'test' },
    { scheduledFor, clampedDelaySeconds: 60, wasClamped: false },
  );
  const futureWakeupAt = new Date(Date.now() + 30 * minute);
  futureWakeupAt.setSeconds(0, 0);
  const rows = [
    // Made by an earlier process of the session; its job died with it.
    ...cronCreate('before01', processStartedAt - 10 * minute),
    ...cronCreate('kept0001', processStartedAt + 5 * minute),
    ...cronCreate('deleted1', processStartedAt + 6 * minute),
    ...toolCallRows(sessionId, 'toolu_delete', 'CronDelete', processStartedAt + 7 * minute, { id: 'deleted1' }, { id: 'deleted1' }),
    ...wakeup('toolu_wakeup_past', processStartedAt + 8 * minute, Date.now() - 10 * minute),
    ...wakeup('toolu_wakeup_future', processStartedAt + 9 * minute, futureWakeupAt.getTime()),
  ];
  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  try {
    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', projectDirectory, 'External session', now, now, transcriptPath);

      await withClaudeCliRegistry(
        [{ pid: process.pid, sessionId, status: 'idle', startedAt: processStartedAt }],
        async () => await withProviders(
          { claude: { run: async () => undefined, abort: () => false } },
          async () => {
            const [entry] = await sessionsService.listRunningSessions();
            assert.equal(entry.external, true);
            assert.deepEqual(entry.crons, [
              { id: 'kept0001', schedule: '7 * * * *', recurring: true, prompt: 'run kept0001' },
              {
                id: 'toolu_wakeup_future',
                schedule: `${futureWakeupAt.getMinutes()} ${futureWakeupAt.getHours()} * * *`,
                recurring: false,
                prompt: 'wake toolu_wakeup_future',
              },
            ]);
          },
        ),
      );
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test('scheduled prompts drop when they expire, and a failed call schedules nothing', () => {
  const day = 24 * 60 * 60_000;
  const createdAt = new Date(2026, 9, 5, 12, 0).getTime();
  const call = (toolId: string, toolName: string, toolInput: Record<string, unknown>, toolUseResult: Record<string, unknown>, isError = false) => ({
    id: toolId, sessionId: 's', provider: 'claude' as const, kind: 'tool_use' as const,
    timestamp: new Date(createdAt).toISOString(), toolId, toolName, toolInput,
    toolResult: { content: '', isError, toolUseResult },
  });
  const cron = (id: string, schedule: string, recurring: boolean) =>
    call(`toolu_${id}`, 'CronCreate', { cron: schedule, prompt: id, recurring }, { id });
  const messages = [
    cron('recurring', '*/5 * * * *', true),
    // Fires at 14:30 on the day it was made.
    cron('literal', '30 14 5 10 *', false),
    // Not a literal date: it lasts as long as the process.
    cron('pattern', '0 9 * * 1', false),
    call('toolu_failed', 'CronCreate', { cron: '* * * * *', prompt: 'failed' }, { id: 'failed' }, true),
  ];
  const ids = (now: number) => listScheduledPrompts(messages, createdAt, now).map((cron) => cron.id);

  assert.deepEqual(ids(createdAt + 60_000), ['recurring', 'literal', 'pattern']);
  assert.deepEqual(ids(new Date(2026, 9, 5, 14, 30).getTime()), ['recurring', 'pattern']);
  assert.deepEqual(ids(createdAt + 7 * day), ['pattern']);
});

test('a cached history page stops reading an external session\'s Bash as running once its process is gone', { concurrency: false }, async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'external-exit-'));
  const sessionId = 'claude-native-external-exit';
  const rows = [
    {
      type: 'assistant', uuid: 'bash-call', sessionId, timestamp: '2026-10-03T10:05:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'sleep 900' } }] },
    },
    {
      type: 'user', uuid: 'bash-ack', sessionId, timestamp: '2026-10-03T10:05:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'Command running in background' }] },
      toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bexit001' },
    },
  ];
  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  try {
    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', projectDirectory, 'External session', now, now, transcriptPath);
      const bashStatus = async () => (await sessionsService.fetchHistory(sessionId)).messages
        .find((message) => message.kind === 'tool_use' && message.toolId === 'toolu_bash')?.backgroundStatus;

      await withClaudeCliRegistry(
        [{ pid: process.pid, sessionId, status: 'idle', startedAt: Date.parse('2026-10-03T10:00:00.000Z') }],
        async () => await withProviders(
          { claude: { run: async () => undefined, abort: () => false } },
          async () => {
            assert.equal((await sessionsService.listRunningSessions()).length, 1);
            assert.equal(await bashStatus(), 'running');

            // Killed outright: the CLI drops out of the registry and writes
            // nothing to the transcript.
            await rm(path.join(os.homedir(), '.claude', 'sessions', `${process.pid}.json`));
            assert.deepEqual(await sessionsService.listRunningSessions(), []);
            assert.equal(await bashStatus(), 'stopped');
          },
        ),
      );
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test('a session another Claude process holds can be archived but not deleted', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('held-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('held-session', 'claude-native-held');

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-held', status: 'idle', startedAt: 1_000 }],
      async () => {
        await assert.rejects(
          sessionsService.deleteOrArchiveSessionById('held-session', { force: true }),
          (error: Error & { code?: string; statusCode?: number }) =>
            error.code === 'SESSION_HELD_EXTERNALLY' && error.statusCode === 409,
        );
        assert.ok(sessionsDb.getSessionById('held-session'), 'the row survives');

        assert.equal(
          (await sessionsService.deleteOrArchiveSessionById('held-session')).action,
          'archived',
        );
      },
    );

    // Once that process exits, the delete goes through.
    await withClaudeCliRegistry([], async () => {
      assert.equal(
        (await sessionsService.deleteOrArchiveSessionById('held-session', { force: true })).action,
        'deleted',
      );
    });
  });
});
