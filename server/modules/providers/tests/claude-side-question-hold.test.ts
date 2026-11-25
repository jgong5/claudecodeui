import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  claudeRuntime,
  queryClaudeSDK,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  SideQuestionOutcome,
  SideQuestionRequest,
} from '@/shared/types.js';

/**
 * A native side question asked near the end of a turn used to come back
 * "Side question cancelled": the turn's own `result` released stdin at
 * once, and the CLI cancels every side question in flight when the session
 * it belongs to shuts down. These drive `queryClaudeSDK` with a scripted
 * SDK stream (the seam is `context.createQuery`, as in
 * `claude-runtime-hold.test.ts`) and a controllable `askSideQuestion` stub
 * (as in `claude-native-side-question.test.ts`), and watch the held prompt
 * stream directly: the CLI exits only once it ends.
 */

const SESSION_ID = 'app-hold-side-question';
const NATIVE_ID = 'native-hold-side-question';
const QUESTION = 'Which file holds the router?';
const NATIVE_ANSWER = 'The router lives in src/router.ts.';
const FORK_ANSWER = 'FORK ANSWER';

type NativeAsk = (question: string, options?: { signal?: AbortSignal }) => Promise<unknown>;

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  /** How many emitted messages the production side has finished handling. */
  consumed: () => number;
};

/**
 * A stand-in for the session's own query: scripted messages plus a toggled
 * `askSideQuestion`, and a `released` flag read off its held stdin — the CLI
 * exits once that stream ends, so this is the whole outcome to watch.
 */
function createScriptedQuery(askSideQuestion?: NativeAsk): {
  createQuery: NonNullable<ProviderRuntimeContext['createQuery']>;
  script: Scripted;
} {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  // Advances only once the generator below is resumed for the *next* item —
  // which the consumer only asks for after it finishes handling this one.
  let consumed = 0;

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    consumed: () => consumed,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const _message of prompt) { /* the CLI reads its stdin */ }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
        consumed += 1;
      }
    })();

    const instance = Object.assign(iterator, {
      interrupt: async () => {},
      stopTask: async () => {},
    });
    if (askSideQuestion) {
      // SDK 0.3.311's method is `askSideQuestion(e, t) { … this.request(…) }`:
      // called detached from its query it throws, so the fake does too.
      Object.assign(instance, {
        askSideQuestion(this: unknown, question: string, options?: { signal?: AbortSignal }) {
          if (this !== instance) {
            throw new TypeError('askSideQuestion was called without its query as `this`');
          }
          return askSideQuestion(question, options);
        },
      });
    }
    return instance;
  };

  return { createQuery, script };
}

/** The fork's own query: answers with FORK_ANSWER and counts how often it was started. */
function createForkQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; calls: () => number } {
  let calls = 0;
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = () => {
    calls += 1;
    const iterator = (async function* () {
      yield {
        type: 'assistant', session_id: 'fork-session', parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: FORK_ANSWER }] },
      };
      yield { type: 'result', subtype: 'success', session_id: 'fork-session', result: FORK_ANSWER, duration_ms: 1, num_turns: 1 };
    })();
    return Object.assign(iterator, { interrupt: async () => {} });
  };
  return { createQuery, calls: () => calls };
}

function makeContext(createQuery: NonNullable<ProviderRuntimeContext['createQuery']>): ProviderRuntimeContext {
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };
}

// A short, fixed pause used only where a predicate already confirmed the
// event that must precede a *negative* assertion (see `waitFor` below) — it
// is never the only thing a test waits on.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

/**
 * Polls `condition` until it holds, instead of guessing a fixed delay — the
 * 25ms `settle()` this replaced was long enough alone but not always under
 * the full suite's parallel load. Fails with a clear message once
 * `timeoutMs` passes without the condition becoming true.
 */
async function waitFor(
  condition: () => boolean,
  { timeoutMs = 2000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      assert.ok(condition(), `condition never became true within ${timeoutMs}ms`);
      return;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, stepMs); });
  }
}

/**
 * Emits a scripted message and waits for the production side to have pulled
 * it (and finished its synchronous handling of it) off the queue, rather
 * than guessing how long that takes. `Scripted.consumed()` only advances once
 * the generator in `createScriptedQuery` is resumed for the *next* item,
 * which the consumer only does after it is done processing this one.
 */
async function emitAndFlush(script: Scripted, message: Record<string, unknown>): Promise<void> {
  const before = script.consumed();
  script.emit(message);
  await waitFor(() => script.consumed() > before);
}

/** Wraps a native stub so tests can wait for it having actually been called. */
function trackCalls(native: NativeAsk): { native: NativeAsk; called: () => boolean } {
  let calls = 0;
  return {
    native: (question, options) => { calls += 1; return native(question, options); },
    called: () => calls > 0,
  };
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 });
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

function makeRequest(cwd: string | null, signal: AbortSignal): SideQuestionRequest {
  return {
    appSessionId: SESSION_ID,
    providerSessionId: NATIVE_ID,
    projectPath: cwd,
    question: QUESTION,
    model: null,
    signal,
  };
}

async function ask(
  request: SideQuestionRequest,
  forkCreateQuery: NonNullable<ProviderRuntimeContext['createQuery']>,
): Promise<{ outcome: SideQuestionOutcome; deltas: string[] }> {
  const deltas: string[] = [];
  const outcome = await claudeRuntime.askSideQuestion(
    request,
    { delta: (text: string) => { deltas.push(text); } },
    makeContext(forkCreateQuery),
  );
  return { outcome, deltas };
}

test('a native side question on a process still taking input is answered natively', { concurrency: false }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-side-question-hold-'));
  const { native, called: nativeCalled } = trackCalls(async () => ({ response: NATIVE_ANSWER, synthetic: false }));
  const { createQuery, script } = createScriptedQuery(native);
  const fork = createForkQuery();
  const writer = { send: () => {}, userId: null };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, makeContext(createQuery));
    await emitAndFlush(script, init());

    const controller = new AbortController();
    const { outcome, deltas } = await ask(makeRequest(cwd, controller.signal), fork.createQuery);
    assert.equal(nativeCalled(), true);
    assert.deepEqual(outcome, { status: 'done', answer: NATIVE_ANSWER });
    assert.deepEqual(deltas, [NATIVE_ANSWER]);
    assert.equal(fork.calls(), 0, 'the native call answered; the fork never started');

    script.emit(result());
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// The runtime lets input go on its own schedule (a turn that ends with
// nothing to hold, a takeover, the silence ceiling); a native question still
// out then is cancelled by the CLI, and is answered on the read-only fork.
test('input let go while a native side question is out is answered once more on the fork', { concurrency: false }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-side-question-hold-'));
  let rejectNative!: (error: unknown) => void;
  const { native, called: nativeCalled } = trackCalls(
    () => new Promise((_resolve, reject) => { rejectNative = reject; }),
  );
  const { createQuery, script } = createScriptedQuery(native);
  const fork = createForkQuery();
  const writer = { send: () => {}, userId: null };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, makeContext(createQuery));
    await emitAndFlush(script, init());

    const controller = new AbortController();
    const asked = ask(makeRequest(cwd, controller.signal), fork.createQuery);
    await waitFor(nativeCalled);

    // The turn ends with nothing backgrounded: input is let go at once.
    await emitAndFlush(script, result());
    await waitFor(() => script.released());

    rejectNative(new Error('Side question cancelled'));
    const { outcome } = await asked;
    assert.equal(fork.calls(), 1, 'a cancellation we did not cause is retried on the fork');
    assert.deepEqual(outcome, { status: 'done', answer: FORK_ANSWER });

    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a dismissed question (its own signal aborted) is not retried', { concurrency: false }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-side-question-hold-'));
  const native: NativeAsk = async () => { throw new Error('Side question cancelled'); };
  const { createQuery, script } = createScriptedQuery(native);
  const fork = createForkQuery();
  const writer = { send: () => {}, userId: null };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, makeContext(createQuery));
    await emitAndFlush(script, init());

    // `dismiss` aborts the question's own signal before the runtime call
    // settles — the service's side, not this runtime's.
    const controller = new AbortController();
    controller.abort();
    const { outcome } = await ask(makeRequest(cwd, controller.signal), fork.createQuery);

    assert.equal(fork.calls(), 0, 'a dismiss never retries');
    assert.equal(outcome.status, 'error');

    script.emit(result());
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
