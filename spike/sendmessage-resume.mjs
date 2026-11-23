// Spike for #71, never lands: does a SendMessage resume of a completed
// background agent start a task the runtime's tracker holds?
// Run from the repo root, in the env the server has:
//   npx tsx --tsconfig server/tsconfig.json spike/sendmessage-resume.mjs [runs]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { createBackgroundWorkTracker } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

const TURN1 = 'Launch one agent with the Agent tool: subagent_type "general-purpose", name "sleeper", '
  + 'run_in_background true, prompt "Run the Bash command `sleep 15`, then reply first-done." '
  + 'Do nothing else; end your turn right after launching it.';
const TURN2 = 'Use the SendMessage tool to resume the agent you launched earlier (it has completed), '
  + 'with the message "Run the Bash command `sleep 15`, then reply second-done." '
  + 'Do not wait for it; end your turn right after sending.';

const userMessage = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });

// Same shape as the runtime's createInputStream: stdin stays open until release().
function inputStream() {
  const queue = [];
  let released = false;
  let wake = () => {};
  return {
    stream: (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (released) return;
        await new Promise((resolve) => { wake = resolve; });
      }
    })(),
    push(message) { queue.push(message); wake(); },
    release() { released = true; wake(); },
  };
}

// Kills and counts every process still running in the run's own cwd.
function leftovers(cwd) {
  const pids = fs.readdirSync('/proc').filter((pid) => {
    try { return /^\d+$/.test(pid) && fs.readlinkSync(`/proc/${pid}/cwd`) === cwd; } catch { return false; }
  });
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  return pids.length;
}

async function run(n) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spike71-')));
  const input = inputStream();
  const tracker = createBackgroundWorkTracker();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 6 * 60 * 1000);
  const toolOf = new Map();
  const t0 = Date.now();
  let phase = 'T1';
  let firstTaskId = null;
  let firstSettled = false;
  let resumedSettled = false;
  const log = (line) => console.log(`run${n} +${((Date.now() - t0) / 1000).toFixed(1)}s ${phase} ${line}`);
  const tagTask = (id) => (id === firstTaskId ? 'first' : `new:${id}`);

  // The options mapCliOptionsToSDK builds for a new session, with every tool approved.
  const claudePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  const q = query({
    prompt: input.stream,
    options: {
      env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(30 * 60 * 1000) },
      extraArgs: { 'replay-user-messages': null },
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      cwd,
      allowedTools: [],
      disallowedTools: [],
      tools: { type: 'preset', preset: 'claude_code' },
      model: 'default',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'user', 'local'],
      canUseTool: async (_name, toolInput) => ({ behavior: 'allow', updatedInput: toolInput }),
      abortController,
    },
  });
  input.push(userMessage(TURN1));

  try {
    for await (const m of q) {
      tracker.apply('s', m);
      if (m.type === 'system' && m.subtype === 'init' && !toolOf.size) {
        log(`init cli=${m.claude_code_version} SendMessage offered=${m.tools.includes('SendMessage')}`);
      } else if (m.type === 'assistant') {
        for (const b of m.message.content.filter((c) => c.type === 'tool_use')) {
          toolOf.set(b.id, b.name);
          log(`tool_use ${b.name} id=${b.id} parent=${m.parent_tool_use_id ?? '-'} input=${JSON.stringify(b.input).slice(0, 140)}`);
        }
      } else if (m.type === 'system' && m.subtype?.startsWith('task_')) {
        if (m.subtype === 'task_started' && phase === 'T1' && toolOf.get(m.tool_use_id) === 'Agent') firstTaskId = m.task_id;
        const status = m.status ?? m.patch?.status ?? '-';
        log(`${m.subtype} task=${tagTask(m.task_id)} tool_use_id=${m.tool_use_id ?? '-'}(${toolOf.get(m.tool_use_id) ?? '?'}) `
          + `type=${m.task_type ?? '-'} status=${status}`);
        const terminal = m.subtype === 'task_notification' || ['completed', 'failed', 'killed'].includes(status);
        if (terminal && phase === 'T1' && m.task_id === firstTaskId) firstSettled = true;
        if (terminal && phase !== 'T1' && m.task_id === firstTaskId) resumedSettled = true;
      } else if (m.type === 'result') {
        log(`result hasOutstanding=${tracker.hasOutstanding('s')} tracked=${JSON.stringify(tracker.list()[0]?.tasks.map((t) => `${tagTask(t.taskId)}/${t.toolName ?? 'nested'}`) ?? [])}`);
        if (phase === 'T1' && firstSettled) {
          phase = 'T2';
          input.push(userMessage(TURN2));
        } else if (phase === 'T2') {
          phase = 'AFTER';
          // Bounds a resumed run that never reports; release kills what it left.
          setTimeout(() => input.release(), 150 * 1000).unref();
        }
        if (phase === 'AFTER' && resumedSettled) input.release();
      }
    }
  } catch (error) {
    log(`error ${error.message}`);
  } finally {
    clearTimeout(timer);
    input.release();
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    log(`done aborted=${abortController.signal.aborted} leftover_processes=${leftovers(cwd)}`);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const runs = Number(process.argv[2] ?? 5);
for (let n = 1; n <= runs; n += 1) {
  await run(n);
}
