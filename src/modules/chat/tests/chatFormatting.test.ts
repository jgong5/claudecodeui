import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatMessageTime, stripProposedPlanEnvelope } from '@/modules/chat/utils/chatFormatting';

test('stripProposedPlanEnvelope removes a complete outer plan envelope', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Session Timeline\n\nPlan body\n</proposed_plan>'),
    '# Session Timeline\n\nPlan body',
  );
});

test('stripProposedPlanEnvelope removes the opening tag while a plan is streaming', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Partial plan'),
    '# Partial plan',
  );
});

test('stripProposedPlanEnvelope preserves tags that are not the outer envelope', () => {
  const content = 'Use `<proposed_plan>` only for plans.';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

test('stripProposedPlanEnvelope preserves an unmatched terminal closing tag', () => {
  const content = 'Ordinary text that mentions a terminal tag.\n</proposed_plan>';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

// Local-time constructors keep these independent of TZ. The seconds (45) and
// the day of the month (23) appear in no other field, so their presence in a
// string means the seconds or the date were rendered.
const NOW = new Date(2026, 9, 10, 18, 0, 0);

test('formatMessageTime shows only hours and minutes for a time on the same local day', () => {
  const { label, title } = formatMessageTime(new Date(2026, 9, 10, 14, 5, 45), NOW);
  assert.equal(label, new Date(2026, 9, 10, 14, 5).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  assert.doesNotMatch(label, /45/);
  assert.match(title, /45/);
});

test('formatMessageTime adds the date, still without seconds, for an earlier day', () => {
  const { label, title } = formatMessageTime(new Date(2026, 6, 23, 14, 5, 45), NOW);
  assert.match(label, /23/);
  assert.doesNotMatch(label, /45/);
  assert.match(title, /23/);
  assert.match(title, /45/);
});
