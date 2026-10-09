import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

/**
 * The Conversations list can hold sessions that no loaded project page does,
 * so the marks on the rows it fetches are reported to the attention map the
 * rows and the page title read.
 */

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: () => Promise.resolve({
      ok: true,
      json: async () => ({
        data: {
          conversations: [
            { sessionId: 's1', provider: 'claude', projectId: null, projectDisplayName: 'repo', sessionTitle: 's1', lastActivity: null, attention: 'done' },
            { sessionId: 's2', provider: 'claude', projectId: null, projectDisplayName: 'repo', sessionTitle: 's2', lastActivity: null, attention: null },
          ],
          total: 2,
          hasMore: false,
        },
      }),
    }),
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const PROJECTS = [] as never[];

test('fetched conversation rows report their marks, null included', async () => {
  const onSessionAttentionRows = vi.fn();
  const { result } = renderHook(() => useSidebarController({
    projects: PROJECTS,
    selectedProject: null,
    selectedSession: null,
    activeSessions: new Set<string>(),
    backgroundSessionIds: new Set<string>(),
    isLoading: false,
    isMobile: false,
    t: ((key: string) => key) as unknown as TFunction,
    onRefresh: vi.fn(),
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    onSessionAttentionRows,
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  }));

  act(() => {
    result.current.setSearchMode('conversations');
  });

  await waitFor(() => assert.equal(onSessionAttentionRows.mock.calls.length, 1));
  assert.deepEqual(onSessionAttentionRows.mock.calls[0][0], [
    { id: 's1', attention: 'done' },
    { id: 's2', attention: null },
  ]);
});
