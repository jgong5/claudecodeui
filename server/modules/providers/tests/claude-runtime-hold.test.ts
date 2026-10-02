import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  exitClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  /** Every query the runtime built, in order; `emit` feeds the latest. */
  queries: ScriptedQuery[];
};

type ScriptedQuery = {
  /** What the runtime wrote to this query's stdin. */
  input: Array<Record<string, unknown>>;
  calls: string[];
  released: boolean;
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  // The runtime builds its query after a few awaits, so the first queue exists
  // up front for whatever the test emits before then.
  const queues: Array<Array<Record<string, unknown> | null>> = [[]];
  const wakes: Array<() => void> = [() => {}];
  const stopped: string[] = [];
  const queries: ScriptedQuery[] = [];

  const script: Scripted = {
    emit: (message) => {
      const index = Math.max(queries.length - 1, 0);
      queues[index].push(message);
      wakes[index]();
    },
    end: () => { queues.forEach((queue, index) => { queue.push(null); wakes[index](); }); },
    released: () => queries[queries.length - 1].released,
    stopped,
    queries,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    const index = queries.length;
    if (!queues[index]) {
      queues.push([]);
      wakes.push(() => {});
    }
    const queue = queues[index];
    const scripted: ScriptedQuery = { input: [], calls: [], released: false };
    queries.push(scripted);

    void (async () => {
      for await (const message of prompt) {
        scripted.input.push(message as Record<string, unknown>);
      }
      scripted.released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wakes[index] = resolve; });
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => { scripted.calls.push('interrupt'); },
      close: () => { scripted.calls.push('close'); queue.push(null); wakes[index](); },
      setModel: async (model?: string) => { scripted.calls.push(`setModel:${model}`); },
      setPermissionMode: async (mode: string) => { scripted.calls.push(`setPermissionMode:${mode}`); },
      cancelAsyncMessage: async (uuid: string) => { scripted.calls.push(`cancel:${uuid}`); return true; },
      stopTask: async (taskId: string) => { stopped.push(taskId); },
    });
  };

  return { createQuery, script };
}

type RunContext = {
  script: Scripted;
  sent: NormalizedMessage[];
  done: Promise<unknown>;
  cwd: string;
  context: ProviderRuntimeContext;
};

async function withRun(runTest: (run: RunContext) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    await runTest({ script, sent, done, cwd, context });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** A second writer, standing in for the run a later send registers. */
function createWriter() {
  const sent: NormalizedMessage[] = [];
  return { sent, writer: { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null } };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);

    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

/** Leaves the session held for a Monitor, which reports no task events. */
const holdForMonitor = async (script: Scripted) => {
  script.emit(init());
  script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
  script.emit(ack('toolu_monitor', 'Monitor started', {}));
  script.emit(result());
  await settle();
};

test('a message sent while the process is held is pushed into it, not a new process', async () => {
  await withRun(async ({ script, cwd, context }) => {
    await holdForMonitor(script);
    const next = createWriter();

    let settled = false;
    const pushed = queryClaudeSDK('and then?', { sessionId: SESSION_ID, cwd }, next.writer as never, context)
      .then(() => { settled = true; });
    await settle();

    assert.equal(script.queries.length, 1, 'no new query');
    const [live] = script.queries;
    assert.deepEqual(live.calls, [], 'nothing interrupted');
    assert.equal(live.released, false);
    const last = live.input[live.input.length - 1];
    assert.equal((last.message as { content: string }).content, 'and then?');
    assert.equal(last.priority, 'next');
    assert.equal(settled, false, 'the send waits on the process, like the run that started it');

    // The pushed turn streams to the new send's writer and reports its own end.
    script.emit(result());
    await settle();
    assert.ok(next.sent.some((message) => message.kind === 'complete'));

    script.end();
    await pushed;
  });
});

test('a held process whose next message needs new settings is replaced', async () => {
  await withRun(async ({ script, cwd, context }) => {
    await holdForMonitor(script);

    void queryClaudeSDK('think harder', { sessionId: SESSION_ID, cwd, effort: 'high' }, createWriter().writer as never, context);
    await settle();

    assert.equal(script.queries.length, 2);
    assert.deepEqual(script.queries[0].calls, ['interrupt']);
    assert.equal(script.queries[0].released, true);
  });
});

test('BG_WAIT_CEILING_MS sets the silence ceiling, and 0 arms none', async () => {
  const previous = process.env.BG_WAIT_CEILING_MS;
  try {
    process.env.BG_WAIT_CEILING_MS = '20';
    await withRun(async ({ script }) => {
      await holdForMonitor(script);
      await settle();
      assert.equal(script.released(), true, 'released after 20ms of silence');
    });

    process.env.BG_WAIT_CEILING_MS = '0';
    await withRun(async ({ script }) => {
      await holdForMonitor(script);
      await settle();
      assert.equal(script.released(), false, 'held until the work reports or /exit');
    });
  } finally {
    if (previous === undefined) {
      delete process.env.BG_WAIT_CEILING_MS;
    } else {
      process.env.BG_WAIT_CEILING_MS = previous;
    }
  }
});

test('Stop interrupts the turn and cancels pushed messages; /exit closes the process', async () => {
  await withRun(async ({ script, cwd, context }) => {
    script.emit(init());
    await settle();
    void queryClaudeSDK('also this', { sessionId: SESSION_ID, cwd }, createWriter().writer as never, context);
    await settle();
    const [live] = script.queries;
    const pushedUuid = live.input[live.input.length - 1].uuid;

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.deepEqual(live.calls, [`cancel:${pushedUuid}`, 'interrupt'], 'not closed');
    assert.equal(live.released, false, 'the stopped turn\'s result decides the hold');

    assert.equal(exitClaudeSDKSession(SESSION_ID), true);
    assert.equal(live.calls.at(-1), 'close');
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('a process held with no tracked task is listed with an empty task list', async () => {
  await withRun(async ({ script }) => {
    await holdForMonitor(script);
    assert.deepEqual(listClaudeSDKBackgroundWork(), [{ sessionId: SESSION_ID, tasks: [] }]);
  });
});
