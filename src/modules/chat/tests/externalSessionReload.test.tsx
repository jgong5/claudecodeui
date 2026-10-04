import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A transcript change on disk reloads the viewed session — but not while a
 * response streams here, which the stream already delivers. A session a Claude
 * process this server did not spawn holds streams nothing here, so it reloads
 * busy or not.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};
const session: ProjectSession = { id: 'session-a', summary: 'A', lastActivity: '2026-01-01T00:00:00.000Z', messageCount: 1 } as ProjectSession;

const slot = { fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 };
const store = {
  fetchFromServer: vi.fn(async () => slot),
  fetchMore: vi.fn(),
  appendRealtime: vi.fn(),
  refreshLatestFromServer: vi.fn(async () => ({ slot, deferred: false })),
  setActiveSession: vi.fn(),
  isStale: vi.fn(() => false),
  updateStreaming: vi.fn(),
  finalizeStreaming: vi.fn(),
  getMessages: vi.fn(() => []),
  getSessionSlot: vi.fn(() => slot),
};

/** Renders the viewed session busy as `processingSessions` says, then reports one transcript change on disk. */
async function reloadsOnTranscriptChange(processingSessions: SessionActivityMap): Promise<boolean> {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const hook = renderHook(
    ({ externalMessageUpdate }: { externalMessageUpdate: number }) =>
      useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage: vi.fn(),
        resetStreamingState: vi.fn(),
        statusCheckSentAtRef: { current: new Map() },
        lastSeqRef: { current: new Map() },
        sessionStore: store as never,
        processingSessions,
        externalMessageUpdate,
      }),
    { initialProps: { externalMessageUpdate: 0 } },
  );
  store.refreshLatestFromServer.mockClear();
  await act(async () => {
    hook.rerender({ externalMessageUpdate: 1 });
  });
  return store.refreshLatestFromServer.mock.calls.length > 0;
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('a session mid-response here does not reload on a transcript change', async () => {
  assert.equal(await reloadsOnTranscriptChange(new Map([
    ['session-a', { statusText: null, canInterrupt: true, startedAt: 1 }],
  ])), false);
});

test('a busy session an external Claude process holds reloads on a transcript change', async () => {
  assert.equal(await reloadsOnTranscriptChange(new Map([
    ['session-a', { statusText: 'Running in the Claude CLI', canInterrupt: false, startedAt: 1, external: true }],
  ])), true);
});
