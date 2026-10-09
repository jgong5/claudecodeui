import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * "Load more sessions" must fetch on every click, whatever else the sidebar
 * has pending. React only runs a state updater eagerly when the component has
 * no pending update; otherwise it defers the updater to the next render, so a
 * guard that decides inside an updater can skip the fetch and leave the
 * spinner on for good.
 */

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: [{ id: 'session-1', summary: 'one', __provider: 'claude' }],
  sessionMeta: { hasMore: true, total: 30 },
};
// One array for every render: a new one each time re-runs the sidebar's effects without end.
const projects = [project];

const renderController = (onLoadMoreSessions: (projectId: string) => Promise<void>) => renderHook(() =>
  useSidebarController({
    projects,
    selectedProject: null,
    selectedSession: null,
    activeSessions: new Set<string>(),
    backgroundSessionIds: new Set<string>(),
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: vi.fn(),
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    onLoadMoreSessions,
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  }));

test('load more fetches once and clears the spinner while another sidebar update is pending', async () => {
  const loadMore = vi.fn(async () => {});
  const { result } = renderController(loadMore);

  await act(async () => {
    // Queue a sidebar update first, so React defers the next updater.
    result.current.setShowNewProject(true);
    await result.current.loadMoreSessionsForProject('project-1');
  });

  assert.deepEqual(loadMore.mock.calls, [['project-1']]);
  assert.equal(result.current.loadingMoreProjects.size, 0);
});

test('a second click while the first request is in flight sends nothing', async () => {
  let finish: () => void = () => {};
  const loadMore = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { result } = renderController(loadMore);

  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = result.current.loadMoreSessionsForProject('project-1');
    await result.current.loadMoreSessionsForProject('project-1');
  });
  assert.equal(loadMore.mock.calls.length, 1);
  assert.equal(result.current.loadingMoreProjects.has('project-1'), true);

  await act(async () => {
    finish();
    await first;
  });
  assert.equal(result.current.loadingMoreProjects.size, 0);
});
