import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * A project's sessions can sit in the Conversations list without being on any
 * loaded page of the project, so deleting the project clears the marks of those
 * rows as well.
 */

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: () => Promise.resolve({
      ok: true,
      json: async () => ({
        data: {
          conversations: [
            { sessionId: 's1', provider: 'claude', projectId: 'p1', projectDisplayName: 'repo', sessionTitle: 's1', lastActivity: null, attention: 'input' },
            { sessionId: 's2', provider: 'claude', projectId: 'p2', projectDisplayName: 'other', sessionTitle: 's2', lastActivity: null, attention: 'done' },
          ],
          total: 2,
          hasMore: false,
        },
      }),
    }),
    deleteProject: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const PROJECT = { projectId: 'p1', displayName: 'repo', fullPath: '/repo', sessions: [] } as unknown as Project;
const PROJECTS = [PROJECT];

test('deleting a project reports its Conversations rows with attention null', async () => {
  const onSessionAttentionRows = vi.fn();
  const onProjectDelete = vi.fn();
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
    onProjectDelete,
    onSessionAttentionRows,
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  }));

  act(() => {
    result.current.setSearchMode('conversations');
  });
  await waitFor(() => assert.equal(result.current.recentConversations.length, 2));

  act(() => {
    result.current.requestProjectDelete(PROJECT);
  });
  await act(async () => {
    await result.current.confirmDeleteProject();
  });

  assert.deepEqual(onProjectDelete.mock.calls, [['p1']]);
  assert.deepEqual(onSessionAttentionRows.mock.calls.at(-1)?.[0], [{ id: 's1', attention: null }]);
});
