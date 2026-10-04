import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * A session started outside CloudCLI carries a terminal icon on its sidebar
 * row, in the desktop and the touch layout alike, whose label names how it
 * was started. A session the app started carries none.
 */

const layout = vi.hoisted(() => ({ compact: false }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => layout.compact }));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string, options?: { entrypoint?: string }) =>
  options?.entrypoint ? `${key}:${options.entrypoint}` : key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const MARKER = '[aria-label^="tooltips.externalSession"]';
const PROJECT = { projectId: 'project-1', displayName: 'project one', fullPath: '/tmp/project-1', sessions: [] } as unknown as Project;

const renderRow = (session: Record<string, unknown>) => render(
  React.createElement(SidebarSessionItem, {
    project: PROJECT,
    session: { id: 's1', summary: 'session one', __provider: 'claude', ...session } as unknown as SessionWithProvider,
    selectedSession: null,
    isProcessing: false,
    hasBackgroundWork: false,
    needsAttention: false,
    currentTime: new Date('2026-08-21T10:00:00.000Z'),
    isEditing: false,
    renameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onDeleteSession: noop,
    isSelecting: false,
    isChecked: false,
    onToggleSessionSelected: noop,
    t,
  }),
);

for (const compact of [false, true]) {
  test(`${compact ? 'touch' : 'desktop'} layout: an external cli session shows the marker, an app session none`, () => {
    layout.compact = compact;

    const external = renderRow({ origin: 'external', entrypoint: 'cli' });
    const markers = external.container.querySelectorAll(MARKER);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].getAttribute('aria-label'), 'tooltips.externalSessionEntrypointIndicator:cli');
    external.unmount();

    const unknown = renderRow({ origin: 'external', entrypoint: null });
    assert.equal(unknown.container.querySelector(MARKER)?.getAttribute('aria-label'), 'tooltips.externalSessionIndicator');
    unknown.unmount();

    const app = renderRow({ origin: 'app', entrypoint: 'sdk-ts' });
    assert.equal(app.container.querySelectorAll(MARKER).length, 0);
  });
}
