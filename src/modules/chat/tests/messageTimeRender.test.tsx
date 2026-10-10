import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { test } from 'vitest';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine } from '@/shared/types';

/**
 * A run of assistant rows used to show a time only on its first row, so a
 * text reply that followed a tool call had none. Each text reply now carries
 * its own time, with the full date and time as a hover title; tool calls in
 * the run still do not.
 */

const TIMESTAMP = new Date(2026, 6, 23, 14, 5, 45);
const FULL_TIME = TIMESTAMP.toLocaleString();

const previous: ChatMessage = { type: 'assistant', content: 'Earlier reply.', timestamp: TIMESTAMP };
const createDiff = (): DiffLine[] => [];

// MessageSpeakControl reads the voice preference, so the real provider is
// needed rather than a stub.
const renderGrouped = (message: ChatMessage) => render(
  <UiPreferencesProvider>
    <MessageComponent message={message} prevMessage={previous} createDiff={createDiff} provider="claude" />
  </UiPreferencesProvider>,
);

test('a grouped assistant text reply shows its time with the full date and time as title', () => {
  const { container } = renderGrouped({ type: 'assistant', content: 'Follow-on reply.', timestamp: TIMESTAMP });

  const time = container.querySelector(`[title="${FULL_TIME}"]`);
  assert.ok(time, 'expected a time element titled with the full date and time');
  assert.equal(time.textContent, TIMESTAMP.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
});

test('a grouped tool use shows no time', () => {
  // Content is set so the tool-use flag, not empty text, is what keeps the
  // time off this row.
  const { container } = renderGrouped({
    type: 'assistant',
    content: 'Read /tmp/a.txt',
    isToolUse: true,
    toolName: 'Read',
    toolInput: JSON.stringify({ file_path: '/tmp/a.txt' }),
    displayText: 'Read /tmp/a.txt',
    timestamp: TIMESTAMP,
  });

  assert.ok(container.textContent, 'expected the tool use to render');
  // A message, not a value diff: inspecting a jsdom node on failure exhausts memory.
  assert.ok(!container.querySelector(`[title="${FULL_TIME}"]`), 'expected no time on a grouped tool use');
});
