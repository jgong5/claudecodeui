// Spike for #72: does a Monitor started beside a background Bash give the
// tracker a task at the turn's `result`? Never lands.
//
// Run from the repository root, with the env the cloudcli service gets:
//   source /md1/users/jgong5/claude.env
//   npx tsx --tsconfig server/tsconfig.json spike/monitor-task.mjs [runs=5]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { createBackgroundWorkTracker } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

const RUNS = Number(process.argv[2]) || 5;
const AFTER_RESULT_MS = 15000;
const TURN_TIMEOUT_MS = 240000;

const PROMPT = [
  'In this one turn, make both of these tool calls, then end your turn without waiting on either:',
  '1. Bash with run_in_background: true and command `sleep 120`.',
  '2. Monitor with description "spike ticks", timeout_ms 180000, persistent false, and command',
  '   `for i in 1 2 3 4 5 6; do sleep 20; echo tick $i; done`.',
  'Reply "started" and stop. Call no other tool, except ToolSearch if Monitor needs loading.'
].join('\n');

// Same shape as mapCliOptionsToSDK in the runtime (not exported).
function sdkOptions(cwd) {
  const options = {
    cwd,
    env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1800000' },
    extraArgs: { 'replay-user-messages': null },
    permissionMode: 'bypassPermissions',
    allowedTools: [],
    disallowedTools: [],
    tools: { type: 'preset', preset: 'claude_code' },
    model: 'default',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user', 'local']
  };
  const cli = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (cli) {
    options.pathToClaudeCodeExecutable = cli;
  }
  return options;
}

// Stdin held open until release(), like the runtime's createInputStream.
function heldPrompt(text) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const stream = (async function* () {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    await released;
  })();
  return { stream, release };
}

function children() {
  const byParent = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      byParent.set(ppid, [...(byParent.get(ppid) ?? []), Number(entry)]);
    } catch { /* exited meanwhile */ }
  }
  return byParent;
}

function descendants(roots) {
  const byParent = children();
  const found = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    for (const pid of byParent.get(queue.shift()) ?? []) {
      if (!found.has(pid)) {
        found.add(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}

const alive = (pid) => fs.existsSync(`/proc/${pid}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runOnce(n) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-72-'));
  const tracker = createBackgroundWorkTracker();
  const toolById = new Map();
  const prompt = heldPrompt(PROMPT);
  const q = query({ prompt: prompt.stream, options: sdkOptions(cwd) });
  const t0 = Date.now();
  let resultAt = null;
  let tracked = null;
  const stamp = () => (resultAt === null ? 'before result' : `${Date.now() - resultAt}ms after result`);
  console.log(`run ${n}`);

  const loop = (async () => {
    for await (const message of q) {
      tracker.apply('s', message);
      if (message.type === 'system' && message.subtype === 'init') {
        console.log(`  claude_code_version=${message.claude_code_version} model=${message.model}`);
      } else if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block?.type !== 'tool_use') continue;
          toolById.set(block.id, block.name);
          console.log(`  tool_use ${block.name} id=${block.id} parent=${message.parent_tool_use_id ?? '-'} input=${JSON.stringify(block.input)}`);
        }
      } else if (message.type === 'system' && message.subtype?.startsWith('task_')) {
        const { subtype, task_id, task_type, tool_use_id, status, patch } = message;
        console.log(`  ${subtype} task_id=${task_id} task_type=${task_type ?? '-'} tool_use_id=${tool_use_id ?? '-'} tool=${toolById.get(tool_use_id) ?? '-'}${status ? ` status=${status}` : ''}${patch ? ` patch=${JSON.stringify(patch)}` : ''} (${stamp()})`);
      } else if (message.type === 'result' && resultAt === null) {
        resultAt = Date.now();
        tracked = tracker.list().flatMap((entry) => entry.tasks);
        console.log(`  result #1 at ${resultAt - t0}ms: tracked=${JSON.stringify(tracked.map(({ taskId, toolName, taskType, nested }) => ({ taskId, toolName, taskType, nested })))}`);
      }
    }
  })();

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while ((resultAt === null || Date.now() - resultAt < AFTER_RESULT_MS) && Date.now() < deadline) {
    await sleep(250);
  }

  // Teardown: everything this script spawned dies here, whatever the CLI does on EOF.
  const spawned = descendants([process.pid]);
  prompt.release();
  await Promise.race([loop.catch(() => {}), sleep(5000)]);
  q.close();
  await sleep(1000);
  for (const pid of new Set([...spawned, ...descendants([process.pid, ...spawned])])) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await sleep(500);
  const leftover = [...spawned].filter(alive);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });

  const calledMonitor = [...toolById.values()].includes('Monitor');
  const monitorTracked = Boolean(tracked?.some((task) => task.toolName === 'Monitor'));
  console.log(`  run ${n}: called Monitor=${calledMonitor} Monitor tracked at result=${monitorTracked} spawned=${spawned.size} leftover=${leftover.length}`);
  return { calledMonitor, monitorTracked, gotResult: resultAt !== null };
}

const results = [];
for (let n = 1; n <= RUNS; n += 1) {
  results.push(await runOnce(n));
}
const valid = results.filter((r) => r.gotResult && r.calledMonitor);
console.log(`Monitor tracked at result in ${valid.filter((r) => r.monitorTracked).length}/${valid.length} valid runs (${RUNS - valid.length} invalid).`);
