import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { ThemeProvider } from '@/shared/context/ThemeContext';

/**
 * A rendered diagram opens a fullscreen viewer whose zoom is driven in code,
 * because index.html turns browser zoom off. Mermaid itself is stubbed: the
 * SVG it returns is all the viewer consumes.
 */

vi.mock('mermaid', () => ({
  default: {
    initialize: () => undefined,
    render: async () => ({ svg: '<svg data-testid="diagram" viewBox="0 0 10 10"></svg>' }),
  },
}));

const { MermaidDiagram } = await import('@/modules/code-editor');

const renderDiagram = () =>
  render(
    <ThemeProvider>
      <MermaidDiagram code="graph TD; A-->B" />
    </ThemeProvider>,
  );

/** The scale in the viewer diagram's CSS transform. */
const viewerScale = (dialog: HTMLElement) => {
  const transform = dialog.querySelector('svg')?.parentElement?.style.transform ?? '';
  return Number(/scale\(([\d.]+)\)/.exec(transform)?.[1]);
};

test('the expand button opens a zoomable viewer that Escape closes', async () => {
  renderDiagram();

  fireEvent.click(await screen.findByRole('button', { name: 'Expand diagram' }));
  const dialog = screen.getByRole('dialog', { name: 'Diagram viewer' });
  assert.ok(dialog.querySelector('svg[data-testid="diagram"]'));
  assert.equal(viewerScale(dialog), 1);

  const surface = dialog.querySelector('svg')!.parentElement!.parentElement!;
  fireEvent.wheel(surface, { deltaY: -200 });
  assert.ok(viewerScale(dialog) > 1, `scale after wheel-up is ${viewerScale(dialog)}`);

  fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
  assert.equal(viewerScale(dialog), 1);
  // The reset click must not have reached the backdrop.
  assert.ok(screen.queryByRole('dialog'), 'the viewer closed');

  fireEvent.keyDown(document, { key: 'Escape' });
  assert.ok(!screen.queryByRole('dialog'), 'the viewer is still open');
});

test('clicking the diagram opens the viewer; only clicks off the diagram close it', async () => {
  renderDiagram();

  fireEvent.click(await screen.findByTestId('diagram'));
  const dialog = screen.getByRole('dialog', { name: 'Diagram viewer' });

  fireEvent.click(dialog.querySelector('svg')!);
  assert.ok(screen.queryByRole('dialog'), 'the viewer closed');

  // The pan surface around the diagram is the backdrop.
  fireEvent.click(dialog.querySelector('svg')!.parentElement!.parentElement!);
  assert.ok(!screen.queryByRole('dialog'), 'the viewer is still open');

  fireEvent.click(screen.getByTestId('diagram'));
  fireEvent.click(screen.getByRole('button', { name: 'Close diagram viewer' }));
  assert.ok(!screen.queryByRole('dialog'), 'the viewer is still open');
});
