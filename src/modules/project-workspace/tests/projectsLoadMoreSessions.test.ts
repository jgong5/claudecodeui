import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * "Load more sessions" re-reads the project's list from the top. Paging from
 * `offset = rows loaded` drifts once the server's order shifts (a session
 * deleted elsewhere, a new one upserted): rows get skipped, and a `hasMore`
 * computed from local counts can keep the button up while it adds nothing.
 */

const projectsResponse = vi.fn();
const projectSessionsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectSessions: (...args: unknown[]) => projectSessionsResponse(...args),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
  },
}));

const row = (id: string): ProjectSession => ({ id, summary: id, __provider: 'claude' });

const buildProject = (sessionIds: string[], sessionMeta: Project['sessionMeta']): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: sessionIds.map(row),
  sessionMeta,
});

const respondWithPage = (sessionIds: string[], sessionMeta: { hasMore: boolean; total: number }) => {
  projectSessionsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({ projectId: 'project-1', sessions: sessionIds.map(row), sessionMeta }),
  });
};

const renderWithProject = async (project: Project) => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [project] });
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  const { result } = renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn(),
      subscribe: () => () => {},
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });
  return result;
};

const loadedIds = (project: Project) => (project.sessions ?? []).map((session) => session.id);

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectSessionsResponse.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

test('load more re-reads from the top, so a session deleted elsewhere does not make it skip a row', async () => {
  const result = await renderWithProject(buildProject(['a', 'b'], { hasMore: true, total: 4 }));
  // `a` was deleted from another tab: the server's list moved up by one.
  respondWithPage(['b', 'c', 'd'], { hasMore: false, total: 3 });

  await act(async () => {
    await result.current.loadMoreProjectSessions('project-1');
  });

  assert.deepEqual(projectSessionsResponse.mock.calls, [['project-1', { limit: 22, offset: 0 }]]);
  const [project] = result.current.projects;
  assert.deepEqual(loadedIds(project), ['a', 'b', 'c', 'd']);
  assert.deepEqual(project.sessionMeta, { hasMore: false, total: 3 });
});

test('the server decides hasMore, even when local rows already reach the stale total', async () => {
  // A session upserted live counts toward the local rows, so they reach `total`
  // while the server still has older ones.
  const result = await renderWithProject(buildProject(['new', 'a', 'b'], { hasMore: true, total: 3 }));
  respondWithPage(['new', 'a', 'b', 'c'], { hasMore: true, total: 30 });

  await act(async () => {
    await result.current.loadMoreProjectSessions('project-1');
  });

  assert.equal(projectSessionsResponse.mock.calls.length, 1);
  const [project] = result.current.projects;
  assert.deepEqual(loadedIds(project), ['new', 'a', 'b', 'c']);
  assert.deepEqual(project.sessionMeta, { hasMore: true, total: 30 });
});
