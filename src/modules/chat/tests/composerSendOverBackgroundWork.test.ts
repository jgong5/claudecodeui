import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A Claude session takes a new message into its live process — mid-turn or
 * while background work runs — so the composer sends it straight away. Only
 * an edit still replaces the process the work runs under, and asks first.
 * `/exit` ends that process over the chat socket.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const backgroundOnly: SessionActivityMap = new Map([[
  'session-1',
  {
    statusText: null,
    canInterrupt: false,
    startedAt: 1,
    background: true,
    tasks: [
      { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit the frontend', workflowName: 'frontend-architecture-audit', startedAt: 1 },
      { taskId: 'b1', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 2, nested: true },
      { taskId: 'a1', toolUseId: 'toolu_agent', taskType: 'local_agent', description: 'Survey the repo', startedAt: 3 },
    ],
  },
]]);

const submit = async (
  processingSessions: SessionActivityMap,
  {
    provider = 'claude',
    isLoading = false,
    edit = false,
    content = 'hello',
  }: { provider?: 'claude' | 'codex'; isLoading?: boolean; edit?: boolean; content?: string } = {},
) => {
  const sent: Array<{ type: string }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider,
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading,
      processingSessions,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string }); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  if (edit) {
    await act(async () => { view.result.current.beginEditMessage({ type: 'user', content: 'old', timestamp: 1, transcriptAnchorId: 'anchor-1' }); });
  }
  // A `/` command only runs once the command list has loaded.
  if (content.startsWith('/')) {
    await waitFor(() => assert.ok(view.result.current.slashCommandsCount > 0));
  }
  await act(async () => { view.result.current.setInput(content); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  return { sends: sent.filter((message) => message.type === 'chat.send'), sent, view };
};

const confirm = vi.fn<(message?: string) => boolean>();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/commands/list')) {
      return json({ builtIn: [{ name: '/exit', description: 'End the process', namespace: 'builtin', metadata: { type: 'builtin' } }], custom: [] });
    }
    if (String(url).includes('/api/commands/execute')) {
      return json({ type: 'builtin', action: 'exit', data: {}, command: '/exit' });
    }
    return json([]);
  }));
  vi.stubGlobal('confirm', confirm);
  confirm.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('sending on a session with background work sends without asking', async () => {
  const { sends } = await submit(backgroundOnly);

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(sends.length, 1);
});

test('a Claude message sent mid-turn goes out at once instead of being queued', async () => {
  const { sends, view } = await submit(new Map(), { isLoading: true });

  assert.equal(sends.length, 1);
  assert.equal(view.result.current.queuedDraft, null);
});

test('other providers still queue a message sent mid-turn', async () => {
  const { sends, view } = await submit(new Map(), { provider: 'codex', isLoading: true });

  assert.equal(sends.length, 0);
  assert.equal(view.result.current.queuedDraft?.content, 'hello');
});

test('an edit on a session with background work asks first, naming the session\'s own tasks', async () => {
  confirm.mockReturnValue(false);
  const { sent, view } = await submit(backgroundOnly, { edit: true });

  assert.equal(confirm.mock.calls.length, 1);
  assert.match(String(confirm.mock.calls[0]?.[0]), /• Workflow frontend-architecture-audit\n• Agent Survey the repo/);
  assert.equal(sent.some((message) => message.type === 'chat.edit-send'), false, 'declined: nothing is sent');
  assert.equal(view.result.current.input, 'hello', 'and the draft stays in the composer');
});

test('an edit on a session held only by scheduled prompts names them, since the edit drops them', async () => {
  confirm.mockReturnValue(false);
  await submit(new Map([['session-1', {
    statusText: null,
    canInterrupt: false,
    startedAt: 1,
    background: true,
    tasks: [],
    crons: [
      { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' },
      { id: 'c2', schedule: '7 9 3 10 *', recurring: false, prompt: '' },
    ],
  }]]), { edit: true });

  assert.equal(confirm.mock.calls.length, 1);
  assert.match(String(confirm.mock.calls[0]?.[0]), /:\n• Cron \*\/5 \* \* \* \* check CI\n• Scheduled 09:07\n/);
});

test('/exit asks the chat socket to end the session\'s process', async () => {
  const { sent, sends } = await submit(new Map(), { content: '/exit' });

  await waitFor(() => assert.ok(sent.some((message) => message.type === 'chat.exit')));
  assert.deepEqual(sent.find((message) => message.type === 'chat.exit'), { type: 'chat.exit', sessionId: 'session-1' });
  assert.equal(sends.length, 0, 'not sent to the model');
});
