import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A Claude session takes a new message into its live process — mid-turn or
 * while background work runs — so the composer sends it straight away. Only
 * an edit still replaces the process the work runs under, and asks first.
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
  { provider = 'claude', isLoading = false }: { provider?: 'claude' | 'codex'; isLoading?: boolean } = {},
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
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  return { sends: sent.filter((message) => message.type === 'chat.send'), view };
};

const confirm = vi.fn<(message?: string) => boolean>();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
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
