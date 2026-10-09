import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession, SessionAttention } from '@/shared/types';
import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import { Sidebar } from '@/modules/sidebar';

/**
 * The sidebar's attention pills and the page title count follow the server's
 * mark alone. Opening a `done` session asks the server to clear it, and the
 * pill goes when the server's `session_upserted` says so; opening an `input`
 * session clears nothing. Rendered through the real Sidebar, with only its
 * unrelated providers and modals stubbed.
 */

const clearSessionAttention = vi.fn();

const row = (id: string, attention: SessionAttention | null = null): ProjectSession => ({
  id,
  summary: `title ${id}`,
  lastActivity: '2026-08-01T00:00:00.000Z',
  __provider: 'claude',
  attention,
});

const PROJECT: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions: [row('viewed'), row('waiting'), row('finished', 'done')],
  sessionMeta: { hasMore: false, total: 3 },
};

const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => ok([PROJECT]),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
    archivedProjects: () => ok({ data: { projects: [] } }),
    getArchivedSessions: () => ok({ data: { sessions: [] } }),
    clearSessionAttention: (sessionId: string) => clearSessionAttention(sessionId),
    providers: { capabilities: () => ok({ success: true, data: { providers: [] } }) },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

const NO_IDS = new Set<string>();
const noop = () => {};

vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => NO_IDS,
  useBackgroundSessionIdSet: () => NO_IDS,
}));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ sidebarVisible: true }),
  useSetUiPreference: () => noop,
}));
vi.mock('@/shared/hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({ updateAvailable: false, restartRequired: false }),
}));
vi.mock('@/modules/task-master', () => ({
  useTaskMaster: () => ({ setCurrentProject: noop, mcpServerStatus: null }),
  useTasksSettings: () => ({ tasksEnabled: false }),
}));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ refreshProjects: noop }) }));
vi.mock('@/modules/settings', () => ({ Settings: () => null }));
vi.mock('@/modules/version-upgrade', () => ({ VersionUpgradeModal: () => null }));
vi.mock('@/modules/project-creation-wizard', () => ({ ProjectCreationWizard: () => null }));

type ServerEventListener = (event: Record<string, unknown>) => void;
const listeners = new Set<ServerEventListener>();

const upsert = (sessionId: string, attention: SessionAttention | null) => {
  for (const listener of listeners) {
    listener({
      kind: 'session_upserted',
      sessionId,
      providerSessionId: null,
      provider: 'claude',
      session: { ...row(sessionId), attention },
      project: { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false },
      timestamp: '2026-08-21T10:00:00.000Z',
    });
  }
};

const subscribe = (listener: (event: never) => void) => {
  listeners.add(listener as ServerEventListener);
  return () => {
    listeners.delete(listener as ServerEventListener);
  };
};

function Workspace() {
  const { sidebarSharedProps } = useProjectsState({
    sessionId: undefined,
    navigate: noop as never,
    subscribe,
    isMobile: false,
    isSessionProcessing: () => false,
  });
  return <Sidebar {...sidebarSharedProps} />;
}

const rowLink = (sessionId: string): HTMLAnchorElement => {
  const link = screen.getByText(`title ${sessionId}`).closest('a');
  assert.ok(link, `row ${sessionId} is rendered`);
  return link;
};

const pillOf = (sessionId: string): string | null =>
  rowLink(sessionId).querySelector('[data-testid="session-attention-pill"]')?.textContent ?? null;

const open = (sessionId: string) => {
  fireEvent.click(rowLink(sessionId));
};

const renderWorkspace = async () => {
  render(<Workspace />);
  await waitFor(() => assert.equal(pillOf('finished'), 'Done'));
};

beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  clearSessionAttention.mockReset();
  clearSessionAttention.mockResolvedValue({ ok: true });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  document.title = '';
});

test('session_upserted drives the pills and title, and only opening a done session clears it', async () => {
  await renderWorkspace();
  open('viewed');
  assert.equal(document.title, '(1) title viewed');

  // 1. `input` on another session: a pill, and the title counts it.
  await act(async () => upsert('waiting', 'input'));
  assert.equal(pillOf('waiting'), 'Needs input');
  assert.equal(document.title, '(2) title viewed');
  assert.ok(rowLink('waiting').className.includes('border-l-amber-500'));
  assert.ok(screen.getByText('title waiting').className.includes('font-semibold'));
  assert.equal(document.querySelectorAll('[role="status"].bg-amber-500').length, 0, 'no amber dot');

  // 2. Opening it keeps the pill and calls nothing.
  open('waiting');
  assert.equal(pillOf('waiting'), 'Needs input');
  assert.equal(document.title, '(2) title waiting');
  assert.equal(clearSessionAttention.mock.calls.length, 0);

  // 3. Opening the `done` session calls the clear route; the server's upsert removes the pill.
  open('finished');
  assert.deepEqual(clearSessionAttention.mock.calls, [['finished']]);
  assert.equal(pillOf('finished'), 'Done', 'the row waits for the server');
  await act(async () => upsert('finished', null));
  assert.equal(pillOf('finished'), null);
  assert.equal(document.title, '(1) title finished');
});

test('done for the viewed session is cleared only while the page is in front', async () => {
  await renderWorkspace();
  open('viewed');

  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  await act(async () => upsert('viewed', 'done'));
  assert.equal(clearSessionAttention.mock.calls.length, 0);
  assert.equal(pillOf('viewed'), 'Done');
  assert.equal(document.title, '(2) title viewed');

  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  await act(async () => upsert('viewed', null));
  await act(async () => upsert('viewed', 'done'));
  assert.deepEqual(clearSessionAttention.mock.calls, [['viewed']]);
});

test('a done mark set while the page was hidden is cleared once the page is back in front', async () => {
  await renderWorkspace();
  open('viewed');

  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  await act(async () => upsert('viewed', 'done'));
  assert.equal(clearSessionAttention.mock.calls.length, 0);

  // Becoming visible without focus is not enough.
  visibility.mockReturnValue('visible');
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(clearSessionAttention.mock.calls.length, 0);

  // Focus arrives: one request, even though both events fire.
  focus.mockReturnValue(true);
  act(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.deepEqual(clearSessionAttention.mock.calls, [['viewed']]);
  assert.equal(pillOf('viewed'), 'Done', 'the row waits for the server');
});
