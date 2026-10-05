import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatInterface from '@/modules/chat/ChatInterface';
import { readDraftText, resetChatDrafts } from '@/shared/chatDrafts';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, Project } from '@/shared/types';

/**
 * Forking from a message opens the new session with that message's text in
 * the composer, so the user can change it and send. The fork button and the
 * handler behind it are real; the session, provider, composer and realtime
 * hooks are stubbed down to what ChatInterface reads while rendering.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'P', fullPath: '/tmp/p' };
const USER_MESSAGE: ChatMessage = {
  type: 'user',
  content: 'Refactor the parser',
  timestamp: '2026-10-05T12:00:00.000Z',
  transcriptAnchorId: 'anchor-1',
};

const forkSession = vi.fn();
vi.mock('@/shared/api', () => ({ api: { forkSession: (...args: unknown[]) => forkSession(...args) } }));

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => undefined }) }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({}),
}));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => undefined }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({ provider: 'claude', pendingPermissionRequests: [], supportsSessionForking: true }),
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [USER_MESSAGE],
    visibleMessages: [USER_MESSAGE],
    currentSessionId: 'source-session',
    setCurrentSessionId: () => undefined,
    scrollContainerRef: { current: null },
  }),
}));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({ input: '', setInput: () => undefined, textareaRef: { current: null } }),
}));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));

const jsonResponse = (ok: boolean, body: unknown) => ({ ok, status: ok ? 200 : 500, json: async () => body });

const renderChat = (onNavigateToSession: (id: string) => void) => render(
  <UiPreferencesProvider>
    <ChatInterface
      isActive
      selectedProject={PROJECT}
      selectedSession={{ id: 'source-session' }}
      ws={null}
      sendMessage={() => undefined}
      onNavigateToSession={onNavigateToSession}
    />
  </UiPreferencesProvider>,
);

const clickFork = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /fork/i }));
  });
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  forkSession.mockReset();
});

test('forking from a user message leaves its text as the new session\'s draft, then opens it', async () => {
  forkSession.mockResolvedValue(jsonResponse(true, { data: { sessionId: 'forked-session' } }));
  const draftsAtNavigation: string[] = [];
  const navigate = vi.fn((id: string) => draftsAtNavigation.push(readDraftText(id)));
  renderChat(navigate);

  await clickFork();

  assert.deepEqual(forkSession.mock.calls, [['source-session', { upToAnchorId: 'anchor-1' }]]);
  assert.deepEqual(navigate.mock.calls.map(([id]) => id), ['forked-session']);
  assert.equal(readDraftText('forked-session'), USER_MESSAGE.content);
  // The draft is in place before the new session's composer reads it.
  assert.deepEqual(draftsAtNavigation, [USER_MESSAGE.content]);
  assert.equal(readDraftText('source-session'), '', 'the source session\'s draft is left alone');
});

test('a failed fork writes no draft and does not navigate', async () => {
  forkSession.mockResolvedValue(jsonResponse(false, { message: 'boom', data: { sessionId: 'forked-session' } }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const navigate = vi.fn();
  renderChat(navigate);

  await clickFork();

  assert.equal(forkSession.mock.calls.length, 1);
  assert.equal(navigate.mock.calls.length, 0);
  assert.equal(readDraftText('forked-session'), '');
});
