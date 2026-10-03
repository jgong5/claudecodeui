import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { notificationPreferencesDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  claudeRuntime,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

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
  /** Control calls that reject, as a CLI refusing them would. */
  failing: Set<string>;
  /** The options the runtime built the query with, hooks included. */
  options: AnyRecord;
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

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    const index = queries.length;
    if (!queues[index]) {
      queues.push([]);
      wakes.push(() => {});
    }
    const queue = queues[index];
    const scripted: ScriptedQuery = { input: [], calls: [], released: false, failing: new Set(), options };
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
      setPermissionMode: async (mode: string) => {
        scripted.calls.push(`setPermissionMode:${mode}`);
        if (scripted.failing.has('setPermissionMode')) {
          throw new Error('refused');
        }
      },
      applyFlagSettings: async (settings: Record<string, unknown>) => { scripted.calls.push(`applyFlagSettings:${JSON.stringify(settings)}`); },
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

async function withRun(runTest: (run: RunContext) => Promise<void>, userId: number | null = null): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId };
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

/** The CLI's echo of a message it took from stdin (`replay-user-messages`). */
const replay = (uuid: unknown) => ({ type: 'user', isReplay: true, uuid, session_id: NATIVE_ID, parent_tool_use_id: null, message: { role: 'user', content: 'echo' } });

/** Pushes a message through the runtime's `run` as the chat gateway does, settling with the message's turn. */
const send = (run: RunContext, content: string, writer: { send: (message: NormalizedMessage) => void }, options: Record<string, unknown> = {}) => {
  let settled = false;
  const turn = claudeRuntime.run(content, { sessionId: SESSION_ID, cwd: run.cwd, settleAtTurnEnd: true, ...options }, writer as never, run.context)
    .then((value) => { settled = true; return value; });
  return { turn, settled: () => settled };
};

const lastInput = (script: Scripted) => {
  const { input } = script.queries[script.queries.length - 1];
  return input[input.length - 1];
};

/** Leaves the session held for a Monitor, which reports no task events. */
const holdForMonitor = async (script: Scripted) => {
  script.emit(init());
  script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
  script.emit(ack('toolu_monitor', 'Monitor started', {}));
  script.emit(result());
  await settle();
};

test('a message sent while the process is held is pushed into it, and settles with its turn', async () => {
  await withRun(async (run) => {
    const { script } = run;
    await holdForMonitor(script);
    const next = createWriter();
    const pushed = send(run, 'and then?', next.writer);
    await settle();

    assert.equal(script.queries.length, 1, 'no new query');
    const [live] = script.queries;
    assert.deepEqual(live.calls, [], 'nothing interrupted');
    assert.equal(live.released, false);
    const last = lastInput(script);
    assert.equal((last.message as { content: string }).content, 'and then?');
    assert.equal(last.priority, 'next');

    script.emit(replay(last.uuid));
    script.emit(result());
    await settle();
    assert.ok(next.sent.some((message) => message.kind === 'complete'), 'the pushed turn reports to its own writer');
    assert.equal(pushed.settled(), true, 'the send settles with its turn, not the process');
    assert.equal(live.released, false, 'the Monitor still holds the process');
  });
});

test('a result that comes while a pushed message is still queued does not end the exchange', async () => {
  await withRun(async (run) => {
    const { script, sent } = run;
    script.emit(init());
    await settle();
    const pushed = send(run, 'one more thing', createWriter().writer);
    await settle();
    const { uuid } = lastInput(script);

    // The message landed after the model's last step: the CLI ends this turn
    // and runs the message as a turn of its own.
    script.emit(result());
    await settle();
    assert.equal(sent.some((message) => message.kind === 'complete'), false, 'no complete yet');
    assert.equal(script.released(), false, 'stdin stays open for the queued turn');
    assert.equal(pushed.settled(), false);

    script.emit(replay(uuid));
    script.emit(result());
    await settle();
    assert.equal(pushed.settled(), true);
    assert.equal(script.released(), true, 'nothing outstanding after the queued turn');
  });
});

test('the turn that starts a process settles before the process held for its work ends', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  try {
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
      normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
      isProviderInstalled: async () => true,
      createQuery,
    };
    const turn = claudeRuntime.run('watch it', { sessionId: SESSION_ID, cwd, settleAtTurnEnd: true }, createWriter().writer as never, context);
    await holdForMonitor(script);
    await turn;
    assert.equal(script.released(), false, 'the process lives on; a dispatcher awaiting the turn does not wait for it');

    // A one-shot caller (the agent API) waits for the work, as before.
    let agentRunSettled = false;
    const agentRun = claudeRuntime.run('again', { sessionId: 'agent-api-session', cwd }, createWriter().writer as never, context)
      .then(() => { agentRunSettled = true; });
    await settle();
    script.emit(init());
    script.emit(toolUse('toolu_monitor2', 'Monitor', { command: 'tail -f y', description: 'watch', timeout_ms: 1000 }));
    script.emit(result());
    await settle();
    assert.equal(agentRunSettled, false, 'held work keeps the agent API waiting');
    script.end();
    await agentRun;
  } finally {
    script.end();
    await settle();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a pushed message applies its model, permission mode, effort and tool lists to the live process', async () => {
  await withRun(async (run) => {
    const { script } = run;
    await holdForMonitor(script);
    send(run, 'plan it', createWriter().writer, {
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'plan',
      toolsSettings: { allowedTools: ['Bash(git:*)'], disallowedTools: ['WebFetch'], skipPermissions: false },
    });
    await settle();

    assert.equal(script.queries.length, 1, 'no new process for new settings');
    assert.deepEqual(script.queries[0].calls, [
      'setModel:sonnet',
      'setPermissionMode:plan',
      'applyFlagSettings:{"effortLevel":"high","ultracode":null,"enableWorkflows":null}',
    ]);
  });
});

test('a control call that fails costs the setting, not the message or the turn', async () => {
  await withRun(async (run) => {
    const { script } = run;
    script.emit(init());
    await settle();
    const [live] = script.queries;
    live.failing.add('setPermissionMode');
    send(run, 'go wild', createWriter().writer, { permissionMode: 'bypassPermissions' });
    await settle();

    assert.equal(script.queries.length, 1);
    assert.deepEqual(live.calls, ['setPermissionMode:bypassPermissions'], 'tried, failed, and nothing interrupted');
    assert.equal((lastInput(script).message as { content: string }).content, 'go wild');
  });
});

test('a stop that met an idle CLI does not swallow the next turn\'s complete', async () => {
  await withRun(async (run) => {
    const { script } = run;
    await holdForMonitor(script);
    // Nothing is running, so the interrupt produces no `result`.
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await settle();

    const next = createWriter();
    send(run, 'still there?', next.writer);
    await settle();
    script.emit(replay(lastInput(script).uuid));
    script.emit(result());
    await settle();
    assert.ok(next.sent.some((message) => message.kind === 'complete'));
  });
});

test('BG_WAIT_CEILING_MS sets the silence ceiling; 0 arms none; invalid values fall back to the default', async () => {
  const previous = process.env.BG_WAIT_CEILING_MS;
  const heldAfterSilence = async (value: string) => {
    process.env.BG_WAIT_CEILING_MS = value;
    let held = false;
    await withRun(async ({ script }) => {
      await holdForMonitor(script);
      await settle();
      held = !script.released();
    });
    return held;
  };
  try {
    assert.equal(await heldAfterSilence('20'), false, 'released after 20ms of silence');
    assert.equal(await heldAfterSilence('0'), true, 'held until the work reports or /exit');
    // Past setTimeout's limit the timer would fire at once; it is capped.
    assert.equal(await heldAfterSilence('1e12'), true);
    for (const invalid of ['', 'soon', '-5']) {
      assert.equal(await heldAfterSilence(invalid), true, `"${invalid}" means the 30 minute default`);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.BG_WAIT_CEILING_MS;
    } else {
      process.env.BG_WAIT_CEILING_MS = previous;
    }
  }
});

test('Stop interrupts the turn and cancels queued pushes; /exit closes the process', async () => {
  await withRun(async (run) => {
    const { script } = run;
    script.emit(init());
    await settle();
    send(run, 'also this', createWriter().writer);
    await settle();
    const [live] = script.queries;
    const pushedUuid = lastInput(script).uuid;

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.deepEqual(live.calls, [`cancel:${pushedUuid}`, 'interrupt'], 'not closed');
    assert.equal(live.released, false, 'the stopped turn\'s result decides the hold');

    assert.equal(claudeRuntime.exit(SESSION_ID), true);
    assert.equal(live.calls.at(-1), 'close');
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(claudeRuntime.exit(SESSION_ID), false, 'nothing left to end');
  });
});

test('a process held with no tracked task is listed with an empty task list', async () => {
  await withRun(async ({ script }) => {
    await holdForMonitor(script);
    const [entry] = listClaudeSDKBackgroundWork();
    assert.equal(entry.sessionId, SESSION_ID);
    assert.deepEqual(entry.tasks, []);
    assert.equal(typeof entry.startedAt, 'number');
  });
});

test('echoes of our own prompts are dropped, the CLI\'s own output still renders', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    await settle();
    const ownPrompt = script.queries[0].input[0];
    script.emit(replay(ownPrompt.uuid));
    script.emit({
      type: 'user', isReplay: true, uuid: 'cli-own-row', session_id: NATIVE_ID, parent_tool_use_id: null,
      message: { role: 'user', content: '<local-command-stdout>Context usage: 12%</local-command-stdout>' },
    });
    // A background agent's report folded into a turn: history folds it into
    // the agent's card, so it must not render as a block of its own live.
    script.emit({
      type: 'user', isReplay: true, uuid: 'cli-queued-row', session_id: NATIVE_ID, parent_tool_use_id: null,
      message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_agent</tool-use-id>\n<status>completed</status>\n<result>AGENTDONE</result>\n</task-notification>' },
    });
    await settle();

    const texts = sent.filter((message) => message.kind === 'text');
    assert.deepEqual(texts.map((message) => [message.role, message.content]), [['assistant', 'Context usage: 12%']]);
  });
});

test('a tracked task that settles inside a pushed turn lets the process go', async () => {
  await withRun(async (run) => {
    const { script } = run;
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Survey', run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(result());
    await settle();
    assert.equal(script.released(), false, 'held for the agent');

    send(run, 'how is it going?', createWriter().writer);
    await settle();
    // The CLI folds the agent's report into the user's turn.
    script.emit(replay(lastInput(script).uuid));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'nothing tracked is left and nothing untracked was held');
  });
});

test('/exit while the run is still setting up keeps the process from starting', async () => {
  await withRun(async ({ script }) => {
    assert.equal(claudeRuntime.exit(SESSION_ID), true);
    await settle();
    assert.equal(script.queries.length, 0, 'no process spawned');
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('a second send before the process starts is queued behind the first prompt', async () => {
  await withRun(async (run) => {
    const { script } = run;
    // Still in setup: nothing spawned yet.
    send(run, 'and quickly this', createWriter().writer);
    await settle();

    assert.equal(script.queries.length, 1, 'one process for both');
    assert.deepEqual(
      script.queries[0].input.map((message) => (message.message as { content: string }).content),
      ['hello', 'and quickly this'],
    );
  });
});

test('the Stop hook\'s scheduled prompts are listed with the held session', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_cron', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check CI', recurring: true }));
    script.emit(ack('toolu_cron', 'Scheduled recurring job c1', { id: 'c1', humanSchedule: 'Every 5 minutes', recurring: true, durable: false }));
    await settle();
    // The CLI runs its Stop hooks just before the turn's `result`.
    const [stopHook] = (script.queries[0].options.hooks as { Stop: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }).Stop[0].hooks;
    await stopHook({ hook_event_name: 'Stop', session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' }] });
    script.emit(result());
    await settle();

    const [entry] = listClaudeSDKBackgroundWork();
    assert.deepEqual(entry.crons, [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' }]);
  });
});

test('scheduled prompts hold the process past the silence ceiling until the last is gone', async (t) => {
  const previous = process.env.BG_WAIT_CEILING_MS;
  process.env.BG_WAIT_CEILING_MS = '1';
  // Every notification reads the user's preferences first; all disabled, so
  // the count is the whole observation.
  const notified = t.mock.method(notificationPreferencesDb, 'getPreferences', () => ({ events: {}, channels: {} }) as never);
  try {
    await withRun(async ({ script }) => {
      const stop = (crons: unknown[]) => {
        const [stopHook] = (script.queries[0].options.hooks as { Stop: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }).Stop[0].hooks;
        return stopHook({ hook_event_name: 'Stop', session_crons: crons });
      };
      script.emit(init());
      script.emit(toolUse('toolu_cron', 'CronCreate', { cron: '*/5 * * * *', prompt: 'check CI', recurring: true }));
      await settle();
      const cron = { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' };
      await stop([cron]);
      script.emit(result());
      await settle();
      assert.equal(script.released(), false, 'a 1ms ceiling would have let go of it');
      assert.equal(notified.mock.callCount(), 1, 'the turn\'s own stop');

      // The job fires as a turn of its own and stays scheduled: not done.
      script.emit(init());
      await stop([cron]);
      script.emit(result());
      await settle();
      assert.equal(script.released(), false);
      assert.equal(notified.mock.callCount(), 1, 'a recurring fire is no completion');

      // A later fire deletes it; its Stop hook lists nothing left.
      script.emit(init());
      await stop([]);
      script.emit(result());
      await settle();
      assert.equal(script.released(), true);
      assert.equal(notified.mock.callCount(), 2, 'the work is done');
    }, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.BG_WAIT_CEILING_MS;
    } else {
      process.env.BG_WAIT_CEILING_MS = previous;
    }
  }
});
