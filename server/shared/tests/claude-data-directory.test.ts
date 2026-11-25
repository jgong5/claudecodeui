import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { resolveClaudeDataDirectory, resolveClaudeGlobalConfigPath } from '@/shared/utils.js';

const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (previousClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  }
});

test('follows an absolute CLAUDE_CONFIG_DIR like the CLI does', () => {
  const configDirectory = path.join(os.tmpdir(), 'claude-config');
  process.env.CLAUDE_CONFIG_DIR = `  ${configDirectory}  `;
  assert.equal(resolveClaudeDataDirectory(), configDirectory);
});

test('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset, blank or relative', () => {
  const defaultDirectory = path.join(os.homedir(), '.claude');
  for (const value of [undefined, '   ', 'relative/claude']) {
    if (value === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = value;
    }
    assert.equal(resolveClaudeDataDirectory(), defaultDirectory, String(value));
  }
});

test('puts .claude.json in CLAUDE_CONFIG_DIR, or in the home folder itself by default', () => {
  const configDirectory = path.join(os.tmpdir(), 'claude-config');
  process.env.CLAUDE_CONFIG_DIR = configDirectory;
  assert.equal(resolveClaudeGlobalConfigPath(), path.join(configDirectory, '.claude.json'));
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(resolveClaudeGlobalConfigPath(), path.join(os.homedir(), '.claude.json'));
});
