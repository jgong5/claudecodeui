import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * While another Claude process holds the session, the composer sends nothing:
 * no message and no slash command.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const heldExternally: SessionActivityMap = new Map([[
  'session-1',
  { statusText: null, canInterrupt: false, startedAt: 1, background: true, external: true },
]]);

const fetchMock = vi.fn(async (url: string) => {
  const body = String(url).includes('/api/commands/list')
    ? { builtIn: [{ name: '/cost', description: 'Token usage', namespace: 'builtin', metadata: { type: 'builtin' } }], custom: [] }
    : String(url).includes('/api/commands/execute')
      ? { type: 'builtin', action: 'cost', data: {}, command: '/cost' }
      : [];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
});

const submit = async (processingSessions: SessionActivityMap, content: string) => {
  const sent: Array<{ type: string }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
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
  if (content.startsWith('/')) {
    await waitFor(() => assert.ok(view.result.current.slashCommandsCount > 0));
  }
  await act(async () => { view.result.current.setInput(content); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  const executed = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/commands/execute')).length;
  return { sent, executed };
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a message to a session another Claude process holds is not sent', async () => {
  const { sent } = await submit(heldExternally, 'hello');

  assert.deepEqual(sent, []);
});

test('a slash command on such a session does not run', async () => {
  const { executed } = await submit(heldExternally, '/cost');

  assert.equal(executed, 0);
});

test('both go through once the session is free', async () => {
  assert.equal((await submit(new Map(), 'hello')).sent.filter((message) => message.type === 'chat.send').length, 1);
  assert.equal((await submit(new Map(), '/cost')).executed, 1);
});
