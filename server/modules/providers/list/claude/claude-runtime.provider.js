/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const activeSessions = new Map();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the map entry it shadows: cleared when the
// session is removed, and reset when a newer run takes the key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, and background work releases it as soon as it reports back. This
// ceiling only catches background work that never reports at all, so an abandoned
// session cannot leak a CLI process forever. The timer resets on every message, so it
// measures silence, not total time. It is not armed while the session has scheduled
// prompts (CronCreate, ScheduleWakeup): those live in the CLI process, fire long after
// any silence, and the Stop hook says exactly when the last is gone — CronCreate jobs
// expire on their own after 7 days.
//
// Set with the BG_WAIT_CEILING_MS env var (milliseconds). `0` turns the backstop off:
// a held process then only exits once the main agent is idle and all its background
// work has reported, or on `/exit`. The CLI still gets the default ceiling then.
const DEFAULT_BG_WAIT_CEILING_MS = 30 * 60 * 1000;

// Read on every use rather than once at load, so a test can change it per run.
// Capped at setTimeout's limit: anything larger fires at once.
function readBgWaitCeilingMs() {
  const raw = process.env.BG_WAIT_CEILING_MS;
  const value = Number(raw);
  return raw?.trim() && Number.isFinite(value) && value >= 0
    ? Math.min(value, 2 ** 31 - 1)
    : DEFAULT_BG_WAIT_CEILING_MS;
}

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions, resolvedEffort) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(readBgWaitCeilingMs() || DEFAULT_BG_WAIT_CEILING_MS) };

  // The CLI echoes each user message (`isReplay`) as it takes it from stdin,
  // which is how a pushed message is told apart from one still queued.
  sdkOptions.extraArgs = { 'replay-user-messages': null };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  const claudeExecutablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  ));

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Object} controls - The run's handles on its live process (see queryClaudeSDK):
 *   `releaseInput`, `pushTurn`, `isInputOpen`, `markAborted`, `pendingPushes`, `chatSession`
 */
function addSession(sessionId, queryInstance, writer = null, controls = null) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, whose
  // session-keyed abortedSessionIds flag would be consumed by the new run
  // and suppress its terminal `complete`.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding) {
    supersededInstances.add(existing.instance);
    Promise.resolve()
      .then(() => existing.instance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    existing.controls?.releaseInput();
    // Whatever the superseded process had outstanding dies with it and will
    // never report, so the new run starts from an empty task set.
    backgroundWork.clear(sessionId);
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands, or when a
    // pushed turn switches writers; keep the controls.
    controls: controls || carried?.controls || null
  });
  // The history reader reports a background agent as running or stopped by
  // whether this entry exists, and the cached history does not see this map.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
  // No process, no background work: anything still tracked was killed with it.
  backgroundWork.clear(sessionId);
  // See addSession: a page cached while the process was up still says
  // `running` for any agent that never reported back.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage) {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage);
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// Tool calls that leave work running past the end of a turn. Bash and Agent only
// count when they are backgrounded; the rest defer or watch work by nature.
// Workflow belongs here rather than in a branch of its own: its input schema has
// no foreground option at all, so every call returns a task id immediately and
// reports back in a later turn.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'Workflow']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * Used by the providers module's tests, which pin the tool matching directly:
 * the alternative is driving a whole SDK run to observe whether stdin was held,
 * and the cost of getting this wrong is silently killed background work.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
export function startsBackgroundWork(sdkMessage) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    // A backgrounded subagent outlives the turn exactly like a backgrounded
    // Bash does, so the process has to be held open for it to report back.
    // Agents background by default — `run_in_background` is optional and only
    // an explicit `false` opts out — hence `!== false` rather than `=== true`.
    // A foreground agent must stay out of DEFERRED_WORK_TOOLS: it never pushes
    // a follow-up turn, so it would pin the process for the full ceiling.
    if (block.name === 'Agent') {
      return block.input?.run_in_background !== false;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

// `task_updated` patch statuses after which a task is gone for good. `pending`,
// `running` and `paused` are still outstanding; `killed` is what the CLI
// writes when it stops a task itself (the task notification spells it
// `stopped`).
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Tracks the background tasks each live session still has outstanding, folded
 * from the `system` task events the SDK stream already carries.
 *
 * `startsBackgroundWork` above only knows that a turn *launched* something
 * lasting; this knows what is still running and which task ids it answers to,
 * which is what the running-sessions list and a stop request need once the
 * turn's `result` has gone out and nothing else remembers the session is busy.
 *
 * Verified against a real query (SDK 0.3.165): `task_started` carries
 * `task_id`, `tool_use_id`, `task_type` and `description` for every agent,
 * workflow and backgrounded command (a foreground Bash emits nothing);
 * `task_notification` settles a task with any status; `task_updated` carries
 * only `task_id` and a patch, and is terminal when the patch's `status` is.
 * Housekeeping tasks the CLI starts on its own have no `tool_use_id` and are
 * not tracked — nothing in the transcript could show them.
 *
 * It also keeps the session's scheduled prompts — CronCreate jobs and
 * ScheduleWakeup wakeups — which emit no task events at all. The CLI hands
 * them to the Stop hook as `session_crons` at the end of every turn (a fire
 * is a turn of its own, so the list stays current); `setCrons` records that.
 *
 * Exported so the folding can be driven with the four event shapes directly;
 * the runtime keeps one instance keyed like `activeSessions`.
 *
 * @returns {{
 *   apply: (sessionKey: string, message: Object) => void,
 *   hasOutstanding: (sessionKey: string) => boolean,
 *   has: (sessionKey: string, taskId: string) => boolean,
 *   setCrons: (sessionKey: string, crons: unknown) => void,
 *   crons: (sessionKey: string) => Array<import('@/shared/types.js').SessionCronSummary>,
 *   clear: (sessionKey: string) => void,
 *   list: () => Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>
 * }}
 */
export function createBackgroundWorkTracker() {
  /** @type {Map<string, Map<string, import('@/shared/types.js').BackgroundTaskSummary>>} */
  const sessions = new Map();
  /**
   * Tool-use ids the session's own turns issued, with the tool each called. A
   * task started for a call an agent made inside its own transcript — a
   * workflow agent's backgrounded command, say — reaches this stream too, and
   * nothing in the parent transcript could show it; it is kept for stopping
   * but flagged `nested`. The tool name is what tells a Monitor from a
   * backgrounded Bash: both start a `local_bash` task.
   * @type {Map<string, Map<string, string>>}
   */
  const ownToolUseIds = new Map();
  /** @type {Map<string, Array<import('@/shared/types.js').SessionCronSummary>>} */
  const cronsBySession = new Map();

  const remove = (sessionKey, taskId) => {
    const tasks = sessions.get(sessionKey);
    if (!tasks) {
      return;
    }
    tasks.delete(taskId);
    if (tasks.size === 0) {
      sessions.delete(sessionKey);
    }
  };

  return {
    apply(sessionKey, message) {
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              let ids = ownToolUseIds.get(sessionKey);
              if (!ids) {
                ids = new Map();
                ownToolUseIds.set(sessionKey, ids);
              }
              ids.set(block.id, block.name);
            }
          }
        }
        return;
      }
      if (message?.type !== 'system' || typeof message.task_id !== 'string') {
        return;
      }
      switch (message.subtype) {
        case 'task_started': {
          if (typeof message.tool_use_id !== 'string') {
            return;
          }
          const task = {
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            taskType: message.task_type,
            description: message.description,
            startedAt: Date.now()
          };
          if (typeof message.workflow_name === 'string') {
            task.workflowName = message.workflow_name;
          }
          const toolName = ownToolUseIds.get(sessionKey)?.get(message.tool_use_id);
          if (typeof toolName === 'string') {
            task.toolName = toolName;
          } else {
            task.nested = true;
          }
          let tasks = sessions.get(sessionKey);
          if (!tasks) {
            tasks = new Map();
            sessions.set(sessionKey, tasks);
          }
          tasks.set(task.taskId, task);
          return;
        }
        case 'task_notification':
          remove(sessionKey, message.task_id);
          return;
        case 'task_updated':
          if (TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
            remove(sessionKey, message.task_id);
          }
          return;
        default:
      }
    },

    hasOutstanding(sessionKey) {
      return sessions.has(sessionKey);
    },

    has(sessionKey, taskId) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    setCrons(sessionKey, crons) {
      // Hook input is the CLI's to shape; keep only entries the UI can read.
      const valid = Array.isArray(crons)
        ? crons
          .filter((cron) => typeof cron?.id === 'string' && typeof cron.schedule === 'string')
          .map((cron) => ({
            id: cron.id,
            schedule: cron.schedule,
            recurring: cron.recurring === true,
            prompt: typeof cron.prompt === 'string' ? cron.prompt : ''
          }))
        : [];
      if (valid.length > 0) {
        cronsBySession.set(sessionKey, valid);
      } else {
        cronsBySession.delete(sessionKey);
      }
    },

    crons(sessionKey) {
      return cronsBySession.get(sessionKey) ?? [];
    },

    clear(sessionKey) {
      sessions.delete(sessionKey);
      ownToolUseIds.delete(sessionKey);
      cronsBySession.delete(sessionKey);
    },

    list() {
      return Array.from(sessions, ([sessionId, tasks]) => ({
        sessionId,
        tasks: Array.from(tasks.values())
      }));
    }
  };
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks,
 * yielding whatever is pushed later.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone. While it is
 * pending, later user messages are pushed into the same process, as typing into
 * the interactive CLI does.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send first
 * @returns {{ stream: AsyncIterable, push: (message: Object) => void, release: () => void, isOpen: () => boolean }}
 */
function createInputStream(messages) {
  const queue = [...messages];
  let released = false;
  let wake = () => {};

  const stream = (async function* () {
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift();
      }
      if (released) {
        return;
      }
      // Keeps stdin open — the CLI stays alive until release() is called.
      await new Promise((resolve) => { wake = resolve; });
    }
  })();

  return {
    stream,
    push(message) {
      queue.push(message);
      wake();
    },
    // Puts the run's own prompt ahead of anything pushed while it was built.
    unshift(items) {
      queue.unshift(...items);
      wake();
    },
    release() {
      released = true;
      wake();
    },
    isOpen: () => !released
  };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @param {Function} [onTurnSettled] - Called once the caller's own turn has ended
 * @returns {Promise<void|{pushed: false}>} Settles with the process — or, for a
 *   message pushed into a live process, with that message's turn
 */
async function queryClaudeSDK(command, options = {}, ws, context, onTurnSettled = null) {
  const { sessionId } = options;
  // Updated by each pushed message, so notifications name the latest one.
  let { sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  let idleReleaseTimer = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // Set when the stream reports a task starting during this turn. Task events
  // are the exact word on what is still running, so when the turn produced
  // any, the tracker decides the hold; `startsBackgroundWork` is the fallback
  // for tools that emit none (Monitor, ScheduleWakeup, CronCreate, TaskCreate)
  // and for an SDK that does not report tasks at all.
  let sawTaskEventThisTurn = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // The part of that hold only the static rule knows about.
  let heldForUntrackedWork = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // Set by a pushed message until its turn's `result`.
  let userTurn = false;
  // Set while the latest `result` was a stopped turn's. The SDK throws once
  // the process exits on an error result, and that throw is the stop's echo.
  let lastResultAborted = false;
  // Callers waiting on a turn they started or pushed. Settled when it ends —
  // its `complete`, a stop, or the process going away — not when the process
  // does, which background work can put off indefinitely.
  const turnWaiters = [];
  const settleTurn = () => {
    for (const resolve of turnWaiters.splice(0)) {
      resolve();
    }
  };

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    const ceilingMs = readBgWaitCeilingMs();
    if (ceilingMs === 0) {
      return;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      releasePromptStream();
    }, ceilingMs);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance = null;
  let sdkOptions = null;

  // A session whose process is still up takes the message as its next input,
  // and that process's run loop streams the turn. An edit rewrites history,
  // which only a new process resumed partway can do.
  const liveSession = sessionKey() && !options.resumeAnchorId && !options.resumeFromScratch
    ? getSession(sessionKey())
    : null;
  const pushing = Boolean(liveSession?.controls?.isInputOpen());
  if (!pushing && options.joinedRun) {
    // The gateway joined a run whose process has since let go of its input.
    return { pushed: false };
  }

  // Exists before the setup awaits, so a message sent right behind this one
  // is pushed into it rather than refused or given a second process.
  const input = createInputStream([]);
  releasePromptStream = input.release;
  // Messages are applied to the live process as they come; a failed control
  // call costs only that setting, never the running turn.
  // Resolves whether the CLI took the change, so only a taken one is
  // recorded and a refused one is tried again with the next message.
  const applyControl = (label, call) => Promise.resolve().then(call).then(() => true, (error) => {
    console.warn(`[Claude SDK] Could not apply ${label} to the live session:`, error?.message || error);
    return false;
  });
  const controls = {
    releaseInput: () => releasePromptStream(),
    isInputOpen: () => input.isOpen(),
    // Only app sessions show in the running list; a git commit-message run
    // is keyed by its provider-native id and is nobody's chat.
    chatSession: Boolean(sessionId),
    // Uuids of pushed messages the CLI has not taken yet. It echoes each as
    // it takes it — folded into the running turn, or run as a turn of its own
    // after the current `result` — so a `result` with any left is not the
    // end of the exchange. Stop cancels them.
    pendingPushes: new Set(),
    // Uuids of every message this run wrote to stdin, so their echoes — and
    // only theirs — are kept from the client. The CLI echoes real content
    // too (local command output, `!` bash input), which must still render.
    sentUuids: new Set(),
    // Set by a Stop that arrived before the process was spawned.
    cancelledBeforeStart: false,
    // abort-session already sent the stopped turn's `complete`.
    markAborted: () => {
      turnCompleteSent = true;
      settleTurn();
    },
    /**
     * Hands a later user message to this live process, applying the settings
     * it was sent with. Resolves to `{ turnEnded }`, a promise for the end of
     * its turn (wrapped, or this async function would wait on it), or to null
     * once stdin is released — the caller then needs a new process.
     */
    pushTurn: async (nextOptions, messages, writer, nextSummary) => {
      if (!input.isOpen()) {
        return null;
      }
      // Before the process exists the message just waits in the stream and
      // runs with the settings it is being started with.
      if (queryInstance && sdkOptions) {
        if (
          nextOptions.model !== sdkOptions.model
          && await applyControl('the model', () => queryInstance.setModel(nextOptions.model))
        ) {
          sdkOptions.model = nextOptions.model;
        }
        // Recorded only once taken: a refused switch to bypassPermissions
        // must not make canUseTool approve everything on its own.
        if (
          (nextOptions.permissionMode || 'default') !== (sdkOptions.permissionMode || 'default')
          && await applyControl('the permission mode', () => queryInstance.setPermissionMode(nextOptions.permissionMode || 'default'))
        ) {
          sdkOptions.permissionMode = nextOptions.permissionMode;
        }
        if (
          (nextOptions.effort !== sdkOptions.effort || nextOptions.settings?.ultracode !== sdkOptions.settings?.ultracode)
          // The settings schema has no `max` (low…xhigh) and quietly drops
          // it, so that one only applies when a process is started with it.
          && nextOptions.effort !== 'max'
          // `null` clears a key from the flag layer (see applyClaudeEffort).
          && await applyControl('the effort', () => queryInstance.applyFlagSettings({
            effortLevel: nextOptions.effort ?? null,
            ultracode: nextOptions.settings?.ultracode ?? null,
            enableWorkflows: nextOptions.settings?.enableWorkflows ?? null
          }))
        ) {
          sdkOptions.effort = nextOptions.effort;
          sdkOptions.settings = nextOptions.settings;
        }
        // canUseTool reads these on every call. The CLI keeps the lists it
        // was spawned with, so a tool dropped from the allow list is still
        // auto-allowed there until the next process.
        sdkOptions.allowedTools = nextOptions.allowedTools;
        sdkOptions.disallowedTools = nextOptions.disallowedTools;
      }
      // Checked again: the process may have let go during the awaits.
      if (!input.isOpen()) {
        return null;
      }
      // The rest of the run streams to the dispatcher of this message.
      ws = writer;
      const entry = getSession(sessionKey());
      if (entry) {
        entry.writer = writer;
      }
      sessionSummary = nextSummary ?? sessionSummary;
      // A stop that met an idle CLI got no `result` to consume its flag.
      abortedSessionIds.delete(sessionKey());
      lastResultAborted = false;
      userTurn = true;
      // Its turn reports `complete` again.
      turnCompleteSent = false;
      if (idleReleaseTimer) {
        clearTimeout(idleReleaseTimer);
        idleReleaseTimer = null;
      }
      for (const message of messages) {
        const uuid = createRequestId();
        controls.pendingPushes.add(uuid);
        controls.sentUuids.add(uuid);
        // `next` is what the CLI gives a message typed mid-turn: folded into
        // the running turn at its next step, or run right after it.
        input.push({ ...message, uuid, priority: 'next' });
      }
      return { turnEnded: new Promise((resolve) => { turnWaiters.push(resolve); }) };
    }
  };
  // This run owns the session's process from here: any earlier one is
  // superseded (see addSession).
  const takeOver = () => {
    ownsProcess = true;
    if (onTurnSettled) {
      turnWaiters.push(onTurnSettled);
    }
    if (sessionKey()) {
      addSession(sessionKey(), null, ws, controls);
    }
  };
  // False for a message pushed into another run's process: if its own
  // setup fails, that process, its entry and its turn are not its to end.
  let ownsProcess = false;
  if (!pushing) {
    takeOver();
  }

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    if (pushing) {
      const pushed = await liveSession.controls.pushTurn(sdkOptions, promptMessages, ws, sessionSummary);
      if (pushed) {
        return pushed.turnEnded;
      }
      if (options.joinedRun) {
        return { pushed: false };
      }
      // It let go of its input meanwhile; a held send takes the session over.
      takeOver();
    }
    // Given a uuid like a pushed message, so its echo is recognised.
    const ownPrompt = promptMessages.map((message) => ({ ...message, uuid: createRequestId() }));
    for (const message of ownPrompt) {
      controls.sentUuids.add(message.uuid);
    }
    input.unshift(ownPrompt);

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }],
      // The only place the CLI reports its scheduled prompts: CronCreate and
      // ScheduleWakeup emit no task events, and a fire looks like any turn.
      Stop: [{
        hooks: [async (input) => {
          if (sessionKey()) {
            backgroundWork.setCrons(sessionKey(), input?.session_crons);
          }
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      // A client answered. Announce it on the run stream so the replay buffer
      // and every other attached tab drop the prompt — resolving happens over
      // the inbound socket only, so without this a mid-run page refresh
      // replays the `permission_request` with nothing to retract it and the
      // already-answered prompt resurrects.
      ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // The SDK's own `query`, unless the caller supplies one (tests script the
    // stream to drive the hold logic below without a CLI process).
    if (controls.cancelledBeforeStart) {
      // Stopped while setting up: abort-session already reported the end.
      if (getSession(sessionKey())?.controls === controls) {
        removeSession(sessionKey());
      }
      return;
    }

    const createQuery = context.createQuery ?? query;
    try {
      queryInstance = createQuery({
        prompt: input.stream,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      // The failed attempt never read the stream, so the retry takes it over.
      queryInstance = createQuery({
        prompt: input.stream,
        options: sdkOptions
      });
    }

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, controls);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey(), queryInstance, ws, controls);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // The CLI took a message from stdin. The client already shows it.
      // Its own queued `<task-notification>` is echoed too when folded into a
      // turn; the task events already report it, and history folds that row
      // into the task's card. (Wake-up and cron prompts run as turns of their
      // own and are not echoed; history hides them as meta rows.)
      if (
        message.type === 'user'
        && message.isReplay
        && (
          controls.sentUuids.delete(message.uuid)
          || String(message.message?.content).trimStart().startsWith('<task-notification>')
        )
      ) {
        controls.pendingPushes.delete(message.uuid);
        continue;
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        if (isSubagentPromptEcho(msg)) {
          continue;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      const tokenBudgetData = extractTokenBudget(message)
        || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message));
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      if (startsBackgroundWork(message)) {
        backgroundWorkPending = true;
      }
      if (message.type === 'system' && message.subtype === 'task_started') {
        sawTaskEventThisTurn = true;
      }
      backgroundWork.apply(sessionKey(), message);

      // A task the user stopped gets no follow-up turn from the CLI — only its
      // `stopped` notification — so when that was the last outstanding task
      // nothing will ever push the `result` the release below waits for, and
      // the process would sit until the idle ceiling. Release it here. A
      // completed task is different: the CLI relays its result in a turn of
      // its own, which closing stdin now would cut short.
      if (
        heldForBackgroundWork
        && message.type === 'system'
        && message.subtype === 'task_notification'
        && message.status === 'stopped'
        && !backgroundWork.hasOutstanding(sessionKey())
        && backgroundWork.crons(sessionKey()).length === 0
      ) {
        heldForBackgroundWork = false;
        releasePromptStream();
      }

      if (message.type === 'result' && controls.pendingPushes.size > 0) {
        // A pushed message is still queued: the CLI runs it as a turn of its
        // own next. That turn ends the exchange for the client, and stdin has
        // to stay open for whatever it starts. The ceiling still bounds an
        // echo that never comes (0 keeps it off).
        scheduleRelease();
      } else if (message.type === 'result') {
        assistantBudgetSent = false;
        // The turn is done as far as the client is concerned. A stopped turn's
        // `result` consumes the abort flag: the process may live on and run
        // more turns, which report their own `complete`.
        const abortPending = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
        lastResultAborted = abortPending;
        const stillOutstanding = backgroundWork.hasOutstanding(sessionKey());
        if (abortPending) {
          settleTurn();
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            stopReason: 'aborted'
          });
        } else if (!turnCompleteSent) {
          turnCompleteSent = true;
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
          settleTurn();
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            stopReason: 'completed'
          });
        } else if (heldForBackgroundWork && !stillOutstanding) {
          // A result after the turn already reported complete means the work we
          // held the process open for has finished and pushed a follow-up turn
          // — the last of it, when nothing else is still running.
          notifyBackgroundWorkCompleted({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary
          });
        }
        // Work started during this turn, or work from an earlier turn that
        // has not settled yet (a follow-up turn reports one task in while
        // another is still going), is still running. Hold the process open
        // so it can finish and report back in a follow-up turn; the ceiling
        // is only a backstop for work that never reports.
        //
        // The release when the last task settles is this same branch on the
        // follow-up turn the CLI pushes for it, not the settling event
        // itself: closing stdin at that moment would cut the turn that
        // relays the task's result.
        //
        // When the turn reported its tasks, the tracker is the whole truth: an
        // Agent call without `run_in_background` is scored as background by
        // `startsBackgroundWork`, but the CLI runs it in the foreground and
        // it has settled before this `result` — holding for it kept a process
        // alive for the full ceiling with nothing outstanding.
        //
        // A pushed message's turn is the user talking, not the held work
        // reporting back, so it keeps a hold for untracked work (Monitor,
        // ScheduleWakeup, CronCreate) — nothing else says when that is done.
        // Tracked tasks need no such help: the tracker knows exactly.
        const keepUntrackedHold = userTurn && heldForUntrackedWork;
        // Scheduled prompts only fire while the process lives. The turn's
        // Stop hook has just reported them, so this is current.
        const holdForSchedule = backgroundWork.crons(sessionKey()).length > 0;
        const holdForTurn = (sawTaskEventThisTurn ? stillOutstanding : backgroundWorkPending || stillOutstanding)
          || keepUntrackedHold
          || holdForSchedule;
        heldForUntrackedWork = (backgroundWorkPending && !sawTaskEventThisTurn) || keepUntrackedHold;
        userTurn = false;
        backgroundWorkPending = false;
        sawTaskEventThisTurn = false;
        if (holdForTurn) {
          heldForBackgroundWork = true;
          if (holdForSchedule) {
            // No silence ceiling: a job due in hours is not work gone quiet.
            clearTimeout(idleReleaseTimer);
            idleReleaseTimer = null;
          } else {
            scheduleRelease();
          }
        } else {
          // Either nothing was backgrounded, or the background work just
          // reported in — let the CLI exit now, as it always has.
          heldForBackgroundWork = false;
          releasePromptStream();
        }
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    if (!ownsProcess) {
      // A pushed message whose own setup failed (an unreadable attachment,
      // say): report it, and leave the process and its turn to their run.
      ws.send(createNormalizedMessage({ kind: 'error', content: error.message, sessionId: sessionId || null, provider: 'claude' }));
      return;
    }

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    if (supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = (sessionKey() ? abortedSessionIds.delete(sessionKey()) : false) || lastResultAborted;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    releasePromptStream();
    settleTurn();
  }
}

/**
 * Stops a run still setting up, which has no process yet: it is told not to
 * start one, and its input is let go so a send racing in takes the session
 * over instead of being pushed into a run that will never read it.
 * @param {Object} session - activeSessions entry with no instance yet
 */
function cancelSetup(session) {
  session.controls.cancelledBeforeStart = true;
  session.controls.releaseInput();
  session.controls.markAborted();
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }
  if (!session.instance) {
    cancelSetup(session);
    return true;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Messages pushed into the process that it has not taken yet belong to
    // the turn being stopped. Cancelled first, or the CLI would pick the next
    // one up as soon as the interrupt lands. A failed cancel must not keep
    // the interrupt from running.
    const pending = [...(session.controls?.pendingPushes ?? [])];
    session.controls?.pendingPushes.clear();
    await Promise.allSettled(pending.map((uuid) => session.instance.cancelAsyncMessage?.(uuid)));

    // Stops the current turn only. The process lives on: the stopped turn's
    // `result` decides, like any other, whether background work holds it
    // open or it is let go.
    await session.instance.interrupt();
    session.controls?.markAborted();

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Ends a session's live process outright — the `/exit` command. Unlike a
 * stop, background work dies with it.
 * @param {string} sessionId - Session identifier
 * @returns {boolean} False when the session has no live process
 */
function exitClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    return false;
  }
  if (!session.instance) {
    cancelSetup(session);
    return true;
  }
  // Its run loop winds down silently; the caller reports the end.
  supersededInstances.add(session.instance);
  session.instance.close();
  removeSession(sessionId);
  return true;
}

/**
 * Sessions whose process is still up and taking input, with the background
 * tasks they still have outstanding (none, for a process held only for a
 * ScheduleWakeup or CronCreate) and the scheduled prompts as of the last turn.
 *
 * A session stays here after its turn's `result` for as long as the process
 * is held open — which is exactly the window in which nothing else (the chat
 * run registry marks the run completed at `result`) knows the session is
 * still busy.
 * @returns {Array<{ sessionId: string, startedAt: number, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary>, crons: Array<import('@/shared/types.js').SessionCronSummary> }>}
 */
function listClaudeSDKBackgroundWork() {
  const tasksBySession = new Map(backgroundWork.list().map((entry) => [entry.sessionId, entry.tasks]));
  return Array.from(activeSessions)
    .filter(([, session]) => session.controls?.chatSession && session.controls.isInputOpen())
    .map(([sessionId, session]) => ({
      sessionId,
      startedAt: session.startTime,
      tasks: tasksBySession.get(sessionId) ?? [],
      crons: backgroundWork.crons(sessionId)
    }));
}

/**
 * Whether a message sent now would be pushed into the session's running
 * process rather than start a new one. The chat gateway asks this mid-turn,
 * when the message joins the run already streaming instead of being refused.
 * @param {string} sessionId - Session identifier
 * @returns {boolean}
 */
function acceptsClaudeSDKLiveInput(sessionId) {
  return Boolean(getSession(sessionId)?.controls?.isInputOpen());
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
async function stopClaudeSDKTask(sessionId, taskId) {
  const session = getSession(sessionId);
  if (!session || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  await session.instance.stopTask(taskId);
  return true;
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * When the run behind a session started, or null when no run is up.
 *
 * The history reader uses this to tell a background agent launched by the
 * live process (still able to report back) from one launched by an earlier
 * process that has since exited (never will): a launch row older than the
 * live run cannot belong to it.
 * @param {string} sessionId - Session identifier
 * @returns {number|null} Epoch milliseconds the live run started, or null
 */
function getClaudeSDKSessionStartTime(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active' ? session.startTime : null;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

/**
 * The runtime's `run`. With `settleAtTurnEnd` (the chat gateway, and through
 * it the scheduled-message dispatcher) it settles when the caller's turn ends
 * rather than when the process does: a process held for background work can
 * outlive its turn indefinitely (BG_WAIT_CEILING_MS=0), and the run loop goes
 * on in the background. Resolves `{ pushed: false }` when a joined send found
 * the process no longer taking input.
 */
function runClaudeTurn(command, options, ws, context) {
  // One-shot callers (the agent API, commit messages) want the finished work,
  // background agents included, as on a process-scoped run.
  if (!options.settleAtTurnEnd) {
    return queryClaudeSDK(command, options, ws, context);
  }
  return new Promise((resolve, reject) => {
    queryClaudeSDK(command, options, ws, context, resolve).then(resolve, reject);
  });
}

export const claudeRuntime = {
  run: runClaudeTurn,
  abort: abortClaudeSDKSession,
  exit: exitClaudeSDKSession,
  acceptsLiveInput: acceptsClaudeSDKLiveInput,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  stopClaudeSDKTask,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
