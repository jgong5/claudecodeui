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

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ElicitationRequest, ElicitationResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

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
import { askClaudeSideQuestion } from '@/modules/providers/list/claude/claude-side-question.provider.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled,
  stopNoticeWaitsForIdle
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import {
  getReportedClaudeContextWindow,
  rememberClaudeContextWindow
} from '@/modules/providers/services/provider-token-usage.service.js';
import { createCompleteMessage, createNormalizedMessage, errorMessage } from '@/shared/utils.js';
import type {
  AnyRecord,
  BackgroundTaskSummary,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
  ProviderRunOutcome,
  ProviderRuntimeWriter,
  SessionCronSummary,
  SideQuestionRequest,
  SideQuestionSink,
  SideQuestionOutcome,
} from '@/shared/types.js';

// The notifications module is still JavaScript, and its defaults (`dedupeKey = null`)
// infer as the only accepted types; this states the shape callers really pass.
const notificationEvent = createNotificationEvent as (event: AnyRecord) => unknown;

type ClaudeQuery = ReturnType<NonNullable<ProviderRuntimeContext['createQuery']>>;

/** The run's writer: the WebSocket writer adds a socket swap for reconnects. */
type ClaudeRuntimeWriter = ProviderRuntimeWriter & { updateWebSocket?(rawWs: unknown): void };

type ActiveSession = {
  /** Null while the run is still setting up (see `takeOver`). */
  instance: ClaudeQuery | null;
  startTime: number;
  status: 'active' | 'aborted';
  writer: ClaudeRuntimeWriter | null;
  controls: ClaudeRunControls | null;
};

/** A run's handles on its live CLI process, kept on its activeSessions entry (see queryClaudeSDK). */
type ClaudeRunControls = {
  /** Closes the run's stdin, logging why; the CLI then winds down. */
  releaseInput: (trigger: string) => void;
  isInputOpen: () => boolean;
  /** False for a run keyed by its provider-native id (a git commit message): nobody's chat. */
  chatSession: boolean;
  /** Uuids of pushed messages the CLI has not taken yet. */
  pendingPushes: Set<string>;
  /** Uuids of every message the run wrote to stdin, so only their echoes are dropped. */
  sentUuids: Set<string>;
  cancelledBeforeStart: boolean;
  child: ChildProcess | null;
  exited: Promise<void> | null;
  previousExit: Promise<void> | null | undefined;
  markAborted: () => void;
  pushTurn: (
    nextOptions: AnyRecord,
    messages: AnyRecord[],
    writer: ClaudeRuntimeWriter,
    nextSummary?: string,
  ) => Promise<{ turnEnded: Promise<void> } | null>;
  steer: SteerInput;
};

/** What a steered message carries: its text, attachments, and the id it is tracked by. */
type SteerRequest = {
  command: string;
  images?: unknown;
  files?: unknown;
  messageId: string;
};

type SteerInput = (request: SteerRequest) => Promise<boolean>;

type ToolApprovalDecision = AnyRecord | null;

/** A pending approval's resolver, carrying the lookup fields getPendingApprovalsForSession reads. */
type ToolApprovalResolver = ((decision: ToolApprovalDecision) => void) & AnyRecord;

/**
 * A context-window reading. `used` is what the window holds; `total` is its size.
 */
type TokenBudget = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: { input: number; output: number };
};

const activeSessions = new Map<string, ActiveSession>();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the map entry it shadows: cleared when the
// session is removed, and reset when a newer run takes the key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map<string, ToolApprovalResolver>();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set<string>();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet<ClaudeQuery>();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS ?? '', 10) || 55000;

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

// An MCP server's request for input travels as a permission request under this
// name. It is not a tool the model can call: the name routes the request to the
// client's McpElicitation panel and keys it in the pending-approval list, so a
// page refresh replays it like any other prompt.
const MCP_ELICITATION_TOOL_NAME = 'McpElicitation';

/**
 * Turns the client's answer to an McpElicitation request into the MCP result.
 * The panel accepts with `updatedInput.content` and declines with a denial. No
 * answer at all (an abort, a closed run) is `cancel`, never an invented accept.
 */
function toElicitationResult(decision: ToolApprovalDecision, mode: ElicitationRequest['mode']): ElicitationResult {
  if (!decision || decision.cancelled) {
    return { action: 'cancel' };
  }
  if (!decision.allow) {
    return { action: 'decline' };
  }
  // A URL request is accepted without content: accepting is consent to open
  // the page, and the server learns the outcome from the page itself.
  if (mode === 'url') {
    return { action: 'accept' };
  }
  const content = (decision.updatedInput as AnyRecord | undefined)?.content;
  const fields: Record<string, string | number | boolean | string[]> = {};
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    for (const [key, value] of Object.entries(content as AnyRecord)) {
      // Form fields are flat primitives, or string lists for multi-select.
      const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      const isStringList = Array.isArray(value) && value.every((item) => typeof item === 'string');
      if (isPrimitive || isStringList) {
        fields[key] = value as string | number | boolean | string[];
      }
    }
  }
  return { action: 'accept', content: fields };
}

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(
  model: string,
  effort: unknown,
  modelsDefinition: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS,
): string | undefined {
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
function applyClaudeEffort(sdkOptions: AnyRecord, resolvedEffort: string | undefined) {
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

type ToolApprovalWaitOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onCancel?: (reason: string) => void;
  metadata?: AnyRecord;
};

function waitForToolApproval(requestId: string, options: ToolApprovalWaitOptions = {}): Promise<ToolApprovalDecision> {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise<ToolApprovalDecision>(resolve => {
    let settled = false;

    const finalize = (decision: ToolApprovalDecision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;

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

    const resolver: ToolApprovalResolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId: string, decision: ToolApprovalDecision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry: string, toolName: string, input: unknown) {
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
    } else if (input && typeof input === 'object' && typeof (input as AnyRecord).command === 'string') {
      command = (input as AnyRecord).command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Environment for the spawned CLI. Forwards all host env vars (e.g. ANTHROPIC_BASE_URL);
 * since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
 *
 * Claude Code turns the Artifact tools off for SDK-driven sessions unless
 * CLAUDE_CODE_ARTIFACT is set, so a session continued from this UI would lose them.
 * Default it on; a host value (e.g. CLAUDE_CODE_ARTIFACT=0) still wins.
 *
 * @param {NodeJS.ProcessEnv} [hostEnv] - Environment to forward, `process.env` by default
 * @returns {NodeJS.ProcessEnv} Environment for the spawned CLI
 */
export function buildClaudeSdkEnv(hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    CLAUDE_CODE_ARTIFACT: '1',
    CLAUDE_CODE_ENTRYPOINT: 'claudecodeui',
    ...hostEnv,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(readBgWaitCeilingMs() || DEFAULT_BG_WAIT_CEILING_MS),
  };
}

function mapCliOptionsToSDK(options: AnyRecord = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions: AnyRecord = {};

  sdkOptions.env = buildClaudeSdkEnv();

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
 * @param {Object} controls - The run's handles on its live process (see queryClaudeSDK)
 * @returns {Promise|undefined} The exit of the process this call superseded, or of the one the run
 *   it took over from was waiting for, which the new run awaits before it spawns its own
 */
function addSession(
  sessionId: string,
  queryInstance: ClaudeQuery | null,
  writer: ClaudeRuntimeWriter | null = null,
  controls: ClaudeRunControls | null = null,
): Promise<void> | null | undefined {
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
  let previousExit: Promise<void> | null | undefined;
  if (superseding && existing?.instance) {
    const supersededInstance = existing.instance;
    supersededInstances.add(supersededInstance);
    Promise.resolve()
      .then(() => supersededInstance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    existing.controls?.releaseInput('supersede');
    // A process held for background work, or one that ignores the
    // interrupt, would otherwise run beside the new one.
    existing.controls?.child?.kill('SIGTERM');
    previousExit = existing.controls?.exited;
    // Whatever the superseded process had outstanding dies with it and will
    // never report, so the new run starts from an empty task set.
    backgroundWork.clear(sessionId);
  } else if (existing && !existing.instance && existing.controls !== controls) {
    // A run still in setup, taken over once stopped, may still be waiting
    // for an earlier process to exit; the new run waits for it too.
    previousExit = existing.controls?.previousExit;
  }
  const carried = superseding ? null : existing;
  const sessionEntry: ActiveSession = {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands, or when a
    // pushed turn switches writers; keep the controls.
    controls: controls || carried?.controls || null,
  };
  activeSessions.set(sessionId, sessionEntry);
  // The history reader reports a background agent as running or stopped by
  // whether this entry exists, and the cached history does not see this map.
  sessionHistoryCache.invalidate(sessionId);
  return previousExit;
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId: string) {
  console.log(`[Claude SDK] removeSession ${sessionId}`);
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
function getSession(sessionId: string) {
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
function transformMessage(sdkMessage: AnyRecord): AnyRecord {
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
export function isSubagentPromptEcho(message: AnyRecord | null | undefined) {
  return Boolean(message?.parentToolUseId) && message?.role === 'user' && message?.kind === 'text';
}

function readNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The window a budget is measured against: the one the SDK reported for the
 * session's model when known, else the server-wide CONTEXT_WINDOW setting.
 * @param {number|null|undefined} reportedContextWindow - SDK-reported window
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(reportedContextWindow?: number | null): number {
  if (typeof reportedContextWindow === 'number' && Number.isFinite(reportedContextWindow) && reportedContextWindow > 0) {
    return reportedContextWindow;
  }
  return parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || 160000;
}

/**
 * Reads the context window the SDK measured for the model that served a turn.
 *
 * `result.modelUsage` has one entry per model the turn billed, subagents'
 * included, so the entry has to be the main thread's model. Its key is the id
 * the CLI requested, which for a 1M variant carries a `[1m]` suffix that the
 * assistant rows' `message.model` lacks (`claude-sonnet-5-5[1m]` vs
 * `claude-sonnet-5-5`); newer CLIs also state the bare id as `canonicalModel`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {string|null} mainModel - `message.model` of the turn's main-thread assistant rows
 * @returns {number|null} The reported window, or null when there is none
 */
function readReportedContextWindow(sdkMessage: AnyRecord, mainModel: string | null): number | null {
  const modelUsage = sdkMessage?.type === 'result' ? sdkMessage.modelUsage : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }

  const reported = Object.entries(modelUsage as Record<string, AnyRecord>).filter(
    ([, modelData]) => modelData && typeof modelData === 'object' && readNumber(modelData.contextWindow) > 0
  );
  const exactMatch = reported.find(([modelKey]) => modelKey === mainModel);
  const variantMatch = reported.find(([modelKey, modelData]) => (
    Boolean(mainModel)
    && (modelData.canonicalModel === mainModel || modelKey.replace(/\[[^\]]*\]$/, '') === mainModel)
  ));
  // A turn that billed a single model was served by it, whatever it is called.
  const entry = exactMatch ?? variantMatch ?? (reported.length === 1 ? reported[0] : null);
  return entry ? readNumber(entry[1].contextWindow) : null;
}

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage: AnyRecord, reportedContextWindow?: number | null): TokenBudget {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
  const contextWindow = resolveContextWindow(reportedContextWindow);

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
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage: unknown, reportedContextWindow?: number | null): TokenBudget | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  const message = sdkMessage as AnyRecord;
  if (message.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (message.type !== 'assistant') {
    return null;
  }

  const messageUsage = message.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  return buildTokenBudget(messageUsage, reportedContextWindow);
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
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractCumulativeTokenBudget(rawMessage: unknown, reportedContextWindow?: number | null): TokenBudget | null {
  const sdkMessage = rawMessage as AnyRecord | null;
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    return buildTokenBudget(sdkMessage.usage, reportedContextWindow);
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
  const contextWindow = resolveContextWindow(reportedContextWindow);

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
// reports back in a later turn. Monitor also starts a tracked task; it stays here
// for a stream that reports no task events.
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
export function startsBackgroundWork(sdkMessage: AnyRecord | null | undefined) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block: AnyRecord | null) => {
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
 * workflow and backgrounded command, and for a subagent's foreground Bash
 * (the session's own foreground Bash emits nothing);
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
 */
export function createBackgroundWorkTracker() {
  const sessions = new Map<string, Map<string, BackgroundTaskSummary>>();
  /**
   * Tool-use ids the session's own turns issued, with the tool each called. A
   * task started for a call an agent made inside its own transcript — a
   * workflow agent's backgrounded command, say — reaches this stream too, and
   * nothing in the parent transcript could show it; it is kept for stopping
   * but flagged `nested`. The tool name is what tells a Monitor from a
   * backgrounded Bash: both start a `local_bash` task.
   */
  const ownToolUseIds = new Map<string, Map<string, string>>();
  const cronsBySession = new Map<string, SessionCronSummary[]>();

  const remove = (sessionKey: string, taskId: string) => {
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
    apply(sessionKey: string, message: AnyRecord | null | undefined) {
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              let ids = ownToolUseIds.get(sessionKey);
              if (!ids) {
                ids = new Map<string, string>();
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
          const task: BackgroundTaskSummary = {
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
            tasks = new Map<string, BackgroundTaskSummary>();
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

    hasOutstanding(sessionKey: string) {
      return sessions.has(sessionKey);
    },

    has(sessionKey: string, taskId: string) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    setCrons(sessionKey: string, crons: unknown) {
      // Hook input is the CLI's to shape; keep only entries the UI can read.
      const valid: SessionCronSummary[] = Array.isArray(crons)
        ? crons
          .filter((cron: AnyRecord | null) => typeof cron?.id === 'string' && typeof cron.schedule === 'string')
          .map((cron: AnyRecord) => ({
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

    crons(sessionKey: string | null): SessionCronSummary[] {
      return (sessionKey && cronsBySession.get(sessionKey)) || [];
    },

    outstanding(sessionKey: string): BackgroundTaskSummary[] {
      return Array.from(sessions.get(sessionKey)?.values() ?? []);
    },

    clear(sessionKey: string) {
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
async function buildPromptMessages(command: string, images: unknown, files: unknown, cwd: string) {
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
function createInputStream(messages: AnyRecord[]) {
  const queue = [...messages];
  let released = false;
  let wake: () => void = () => {};

  const stream = (async function* () {
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift() as AnyRecord;
      }
      if (released) {
        return;
      }
      // Keeps stdin open — the CLI stays alive until release() is called.
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();

  return {
    stream,
    push(message: AnyRecord) {
      queue.push(message);
      wake();
    },
    // Puts the run's own prompt ahead of anything pushed while it was built.
    unshift(items: AnyRecord[]) {
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
async function loadMcpConfig(cwd: string | undefined): Promise<AnyRecord | null> {
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
      console.error('Failed to parse ~/.claude.json:', (error as Error).message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers: AnyRecord = {};

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
    console.error('Error loading MCP config:', (error as Error).message);
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
async function queryClaudeSDK(
  command: string,
  options: AnyRecord = {},
  ws: ClaudeRuntimeWriter,
  context: ProviderRuntimeContext,
  onTurnSettled: (() => void) | null = null,
): Promise<ProviderRunOutcome> {
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

  const emitNotification = (event: unknown) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      event
    });
  };

  const notifyStopped = (stopReason: string) => {
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      stopReason
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream: (trigger: string) => void = () => {};
  // Every message steered into this run, by the uuid it was sent with. The CLI
  // echoes a message written to its stdin when it reads it, and only these
  // echoes are shown — the turn's own prompt is already on screen.
  const steeredMessageIds = new Set<string>();
  let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a stop lands while a turn is still running (not on the hold
  // after a completed one), and once its `aborted` notice has gone out: the
  // stopped turn may end with a `result`, a thrown stream or a plain end,
  // and exactly one of them reports it.
  let abortedMidTurn = false;
  let abortNoticeSent = false;
  const notifyAbortedOnce = () => {
    if (abortedMidTurn && !abortNoticeSent) {
      abortNoticeSent = true;
      notifyStopped('aborted');
    }
  };
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // Set when the stream reports a task starting during this turn. Task events
  // are the exact word on what is still running, so when the turn produced
  // any, the tracker decides the hold; `startsBackgroundWork` is the fallback
  // for tools that emit none (ScheduleWakeup, CronCreate, TaskCreate)
  // and for an SDK that does not report tasks at all.
  let sawTaskEventThisTurn = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;
  // The part of that hold only the static rule knows about.
  let heldForUntrackedWork = false;
  // Set when a turn completed with work still running and the user wants its
  // stop notice only once the session is idle: sent when that work is done,
  // or when the process ends.
  let stopNoticeDeferred = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // The window the SDK reported for this session's model (a resumed session
  // starts from the one its last run reported), the model the main thread's
  // assistant rows name, and the budget last published — re-sent with the
  // right total when the turn's `result` is the first to state the window.
  let reportedContextWindow: number | null = getReportedClaudeContextWindow(providerSessionId) ?? null;
  let mainThreadModel: string | null = null;
  let lastSentTokenBudget: TokenBudget | null = null;
  // Set by a pushed message until its turn's `result`.
  let userTurn = false;
  // Set while the latest `result` was a stopped turn's. The SDK throws once
  // the process exits on an error result, and that throw is the stop's echo.
  let lastResultAborted = false;
  // Callers waiting on a turn they started or pushed. Settled when it ends —
  // its `complete`, a stop, or the process going away — not when the process
  // does, which background work can put off indefinitely.
  const turnWaiters: Array<() => void> = [];
  const settleTurn = () => {
    for (const resolve of turnWaiters.splice(0)) {
      resolve();
    }
  };

  // Arms (or re-arms) the idle countdown that eventually closes stdin. Not
  // while the session has scheduled prompts: a job due in hours is not work
  // gone quiet.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    const ceilingMs = readBgWaitCeilingMs();
    if (ceilingMs === 0 || backgroundWork.crons(sessionKey()).length > 0) {
      return;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      releasePromptStream('silence ceiling');
    }, ceilingMs);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer?.unref?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance: ClaudeQuery | null = null;
  let sdkOptions: AnyRecord | null = null;

  // A session whose process is still up takes the message as its next input,
  // and that process's run loop streams the turn. An edit rewrites history,
  // which only a new process resumed partway can do.
  const liveSession = sessionKey() && !options.resumeAnchorId && !options.resumeFromScratch
    ? getSession(sessionKey()!)
    : null;
  const pushing = Boolean(liveSession?.controls?.isInputOpen());
  if (!pushing && options.joinedRun) {
    // The gateway joined a run whose process has since let go of its input.
    return { pushed: false };
  }

  // Exists before the setup awaits, so a message sent right behind this one
  // is pushed into it rather than refused or given a second process.
  const input = createInputStream([]);
  // Logged only when input actually closes, with what the session still had running.
  releasePromptStream = (trigger: string) => {
    if (!input.isOpen()) {
      return;
    }
    input.release();
    const tasks = backgroundWork.list().find((entry) => entry.sessionId === sessionKey())?.tasks ?? [];
    const outstanding = tasks.map((task) => `${task.taskId} (${task.toolName ?? task.taskType})`).join(', ') || 'none';
    console.log(`[Claude SDK] Input released for session ${sessionKey()}: ${trigger}; outstanding tasks: ${outstanding}`);
  };
  // Messages are applied to the live process as they come; a failed control
  // call costs only that setting, never the running turn.
  // Resolves whether the CLI took the change, so only a taken one is
  // recorded and a refused one is tried again with the next message.
  const applyControl = (label: string, call: () => unknown) => Promise.resolve().then(call).then(() => true, (error: unknown) => {
    console.warn(`[Claude SDK] Could not apply ${label} to the live session:`, errorMessage(error));
    return false;
  });
  const controls: ClaudeRunControls = {
    releaseInput: (trigger: string) => releasePromptStream(trigger),
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
    // The CLI process, once spawned, and a promise settled when it exits.
    child: null,
    exited: null,
    // The exit of the process a takeover superseded, awaited before this run
    // spawns its own.
    previousExit: null,
    // abort-session already sent the stopped turn's `complete`.
    markAborted: () => {
      abortedMidTurn = abortedMidTurn || !turnCompleteSent;
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
      const liveQuery = queryInstance;
      const liveOptions = sdkOptions;
      if (liveQuery && liveOptions) {
        if (
          nextOptions.model !== liveOptions.model
          && await applyControl('the model', () => liveQuery.setModel!(nextOptions.model))
        ) {
          liveOptions.model = nextOptions.model;
        }
        // Recorded only once taken: a refused switch to bypassPermissions
        // must not make canUseTool approve everything on its own.
        if (
          (nextOptions.permissionMode || 'default') !== (liveOptions.permissionMode || 'default')
          && await applyControl('the permission mode', () => liveQuery.setPermissionMode!(nextOptions.permissionMode || 'default'))
        ) {
          liveOptions.permissionMode = nextOptions.permissionMode;
        }
        if (
          (nextOptions.effort !== liveOptions.effort || nextOptions.settings?.ultracode !== liveOptions.settings?.ultracode)
          // The settings schema has no `max` (low…xhigh) and quietly drops
          // it, so that one only applies when a process is started with it.
          && nextOptions.effort !== 'max'
          // `null` clears a key from the flag layer (see applyClaudeEffort).
          && await applyControl('the effort', () => liveQuery.applyFlagSettings!({
            effortLevel: nextOptions.effort ?? null,
            ultracode: nextOptions.settings?.ultracode ?? null,
            enableWorkflows: nextOptions.settings?.enableWorkflows ?? null
          }))
        ) {
          liveOptions.effort = nextOptions.effort;
          liveOptions.settings = nextOptions.settings;
        }
        // canUseTool reads these on every call. The CLI keeps the lists it
        // was spawned with, so a tool dropped from the allow list is still
        // auto-allowed there until the next process.
        liveOptions.allowedTools = nextOptions.allowedTools;
        liveOptions.disallowedTools = nextOptions.disallowedTools;
      }
      // Checked again: the process may have let go during the awaits.
      if (!input.isOpen()) {
        return null;
      }
      // The rest of the run streams to the dispatcher of this message.
      ws = writer;
      const entry = sessionKey() ? getSession(sessionKey()!) : undefined;
      if (entry) {
        entry.writer = writer;
      }
      sessionSummary = nextSummary ?? sessionSummary;
      // A stop that met an idle CLI got no `result` to consume its flag.
      abortedSessionIds.delete(sessionKey()!);
      lastResultAborted = false;
      userTurn = true;
      // Its turn reports `complete` again.
      turnCompleteSent = false;
      abortedMidTurn = false;
      abortNoticeSent = false;
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
      return { turnEnded: new Promise<void>((resolve) => { turnWaiters.push(resolve); }) };
    },
    /**
     * Writes a steered message (`chat.steer`) into the running turn, like a
     * pushed send, but shown on screen only once the CLI echoes having read
     * it. Refused once the turn has been reported complete or input is let
     * go: the client then sends it the ordinary way.
     */
    steer: async ({ command: steerCommand, images, files, messageId }) => {
      if (turnCompleteSent || !input.isOpen()) {
        return false;
      }
      const [steerMessage] = await buildPromptMessages(steerCommand, images, files, options.cwd);
      // Reading attachments takes a moment; the turn may have ended meanwhile.
      if (turnCompleteSent || !input.isOpen() || !steerMessage) {
        return false;
      }
      steeredMessageIds.add(messageId);
      // Pending like any pushed message: a `result` before the CLI reads it
      // does not end the exchange, the CLI runs it as the next turn.
      controls.pendingPushes.add(messageId);
      controls.sentUuids.add(messageId);
      input.push({ ...steerMessage, uuid: messageId, priority: 'next' });
      return true;
    }
  };
  // Whether the session's entry is still this run's. A newer run may have
  // taken it over; matched on controls because a run in setup has no
  // instance yet.
  const ownsEntry = () => Boolean(sessionKey()) && getSession(sessionKey()!)?.controls === controls;
  // This run owns the session's process from here: any earlier one is
  // superseded (see addSession).
  const takeOver = () => {
    ownsProcess = true;
    if (onTurnSettled) {
      turnWaiters.push(onTurnSettled);
    }
    if (sessionKey()) {
      const previous = getSession(sessionKey()!);
      let previousState = 'none';
      if (previous) {
        previousState = !previous.instance ? 'setup' : previous.controls?.isInputOpen() ? 'input open' : 'input closed';
      }
      console.log(`[Claude SDK] Takeover of session ${sessionKey()}; previous entry: ${previousState}`);
      controls.previousExit = addSession(sessionKey()!, null, ws, controls);
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
    let effortModels: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const runOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });
    sdkOptions = runOptions;

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    if (pushing) {
      const pushed = await liveSession!.controls!.pushTurn(runOptions, promptMessages, ws, sessionSummary);
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
      runOptions.mcpServers = mcpServers;
    }

    runOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input: AnyRecord) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(notificationEvent({
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
        hooks: [async (input: AnyRecord) => {
          // A superseded process's hook must not overwrite its successor's crons.
          if (ownsEntry()) {
            backgroundWork.setCrons(sessionKey()!, input?.session_crons);
          }
          return {};
        }]
      }]
    };

    // An MCP server asking the person for input mid-call ("elicitation"). The
    // CLI declares form and URL elicitation support to every server, and without
    // this callback the SDK answers each request with `decline` itself — the
    // server is told a person refused when nobody was shown anything. The
    // request takes the permission round trip so it reaches every attached tab,
    // survives a refresh and raises a notification. There is no timeout here:
    // the server keeps its own, and an abort arrives through the signal.
    // An unattended run (commit-message generation, and an agent-API run unless
    // its caller passed `unattended: false`) has nobody to show the form to, so
    // it leaves the callback unset: the SDK then declines at once, rather than
    // the run waiting on an answer that cannot come.
    if (!options.unattended) {
      runOptions.onElicitation = async (request: ElicitationRequest, elicitationOptions: { signal: AbortSignal }) => {
        const requestId = createRequestId();
        const input = {
          serverName: request.serverName,
          message: request.message,
          mode: request.mode ?? 'form',
          requestedSchema: request.requestedSchema,
          url: request.url,
          elicitationId: request.elicitationId,
          title: request.title,
          displayName: request.displayName,
          description: request.description,
        };
        const serverLabel = request.displayName || request.serverName;
        ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName: MCP_ELICITATION_TOOL_NAME, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        emitNotification(notificationEvent({
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          kind: 'action_required',
          code: 'agent.notification',
          meta: { message: `${serverLabel} asks: ${request.message}`, sessionName: sessionSummary },
          severity: 'warning',
          requiresUserAction: true,
          dedupeKey: `claude:elicitation:${sessionId || capturedSessionId || 'none'}:${requestId}`
        }));

        const decision = await waitForToolApproval(requestId, {
          timeoutMs: 0,
          signal: elicitationOptions?.signal,
          metadata: {
            _sessionId: sessionId || capturedSessionId || null,
            _toolName: MCP_ELICITATION_TOOL_NAME,
            _input: input,
            _receivedAt: new Date(),
          },
          onCancel: (reason: string) => {
            ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          }
        });
        if (decision && !decision.cancelled) {
          // Same as canUseTool: retract the answered prompt on every attached tab.
          ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
        return toElicitationResult(decision, request.mode);
      };
    }

    // Tools that need the user (AskUserQuestion, ExitPlanMode) reach this
    // callback in every permission mode, 'auto' and 'bypassPermissions'
    // included: the SDK asks for them before its permission-mode step. Other
    // tools reach it in those modes only when the SDK still wants a prompt
    // (a dangerous rm under bypass, for example), which the bypass branch
    // below approves.
    runOptions.canUseTool = async (toolName: string, input: unknown, context?: { signal?: AbortSignal }) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (runOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (runOptions.disallowedTools || []).some((entry: string) =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (runOptions.allowedTools || []).some((entry: string) =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(notificationEvent({
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
        onCancel: (reason: string) => {
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
          if (!runOptions.allowedTools.includes(decision.rememberEntry)) {
            runOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(runOptions.disallowedTools)) {
            runOptions.disallowedTools = runOptions.disallowedTools.filter((entry: string) => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // The same spawn the SDK makes, kept so a run that takes this session
    // over can SIGTERM the process and wait for its exit.
    runOptions.spawnClaudeCodeProcess = ({ command, args, cwd, env, signal }: { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => {
      const child = spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      controls.child = child;
      controls.exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        // A spawn that fails emits no `exit`.
        child.once('error', () => {
          if (child.pid === undefined) {
            resolve();
          }
        });
      });
      return child;
    };

    // Never two processes for one session: a superseded one exits first.
    await controls.previousExit;

    // The SDK's own `query`, unless the caller supplies one (tests script the
    // stream to drive the hold logic below without a CLI process).
    if (controls.cancelledBeforeStart) {
      // Stopped while setting up: abort-session already reported the end to
      // the client; the user's notice still says the run was stopped.
      if (ownsEntry()) {
        removeSession(sessionKey()!);
      }
      notifyAbortedOnce();
      return;
    }

    const createQuery = context.createQuery ?? query;
    try {
      queryInstance = createQuery({
        prompt: input.stream as AsyncIterable<SDKUserMessage>,
        options: runOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', (hookError as Error)?.message || hookError);
      delete runOptions.hooks;
      // The failed attempt never read the stream, so the retry takes it over.
      queryInstance = createQuery({
        prompt: input.stream as AsyncIterable<SDKUserMessage>,
        options: runOptions
      });
    }

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey()!, queryInstance, ws, controls);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const rawMessage of queryInstance) {
      const message = rawMessage as AnyRecord;
      // One message that cannot be handled costs only that message: leaving
      // the loop would end the run, and the SDK would kill the process and
      // its background work with it.
      try {
        // Capture session ID from first message
        if (message.session_id && !capturedSessionId) {

          capturedSessionId = message.session_id;
          addSession(sessionKey()!, queryInstance, ws, controls);

          // Set session ID on writer
          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId!);
          }

          // Send session-created event only once for sessions with nothing to resume
          if (!providerSessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
          }
        } else {
          // session_id already captured
        }

        // A steered message (`chat.steer`) is shown now, where Claude read it,
        // on every tab watching the run; until then the client only shows it
        // as pending. Read mid-turn, it is stored as an attachment of the
        // turn, not a user row of its own, so it is no anchor for editing.
        if (message.type === 'user' && message.isReplay === true && steeredMessageIds.delete(message.uuid)) {
          for (const steered of context.normalizeMessage(transformMessage(message), capturedSessionId || sessionId || null)) {
            delete steered.transcriptAnchorId;
            ws.send(steered);
          }
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

        if (
          message.type === 'assistant'
          && !message.parent_tool_use_id
          && typeof message.message?.model === 'string'
          && message.message.model !== '<synthetic>'
        ) {
          mainThreadModel = message.message.model;
        }

        // Only a turn's `result` states the window of the model that served it.
        const turnContextWindow = readReportedContextWindow(message, mainThreadModel);
        const contextWindowChanged = Boolean(turnContextWindow) && turnContextWindow !== reportedContextWindow;
        if (turnContextWindow) {
          reportedContextWindow = turnContextWindow;
          rememberClaudeContextWindow(message.session_id || capturedSessionId, turnContextWindow);
          if (contextWindowChanged && sessionKey()) {
            // A history page cached before this turn ended carries the old total.
            sessionHistoryCache.invalidate(sessionKey()!);
          }
        }

        // Extract and send token budget updates from assistant usage payloads,
        // falling back to the turn's cumulative bill only for SDK builds that
        // report no per-assistant usage at all.
        let tokenBudgetData = extractTokenBudget(message, reportedContextWindow)
          || (assistantBudgetSent ? null : extractCumulativeTokenBudget(message, reportedContextWindow));
        if (
          !tokenBudgetData
          && turnContextWindow
          && lastSentTokenBudget
          && lastSentTokenBudget.total !== turnContextWindow
        ) {
          // The reading stands; only the window it is measured against was wrong.
          tokenBudgetData = { ...(lastSentTokenBudget as TokenBudget), total: turnContextWindow };
        }
        if (tokenBudgetData) {
          if (message.type === 'assistant') {
            assistantBudgetSent = true;
          }
          lastSentTokenBudget = tokenBudgetData;
          ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }

        if (startsBackgroundWork(message)) {
          backgroundWorkPending = true;
        }
        if (message.type === 'system' && message.subtype === 'task_started') {
          sawTaskEventThisTurn = true;
        }
        // The tracker is keyed by session, not by run: a superseded process
        // reporting a task it shares an id with (a resumed agent) would drop the
        // new process's task.
        if (ownsEntry()) {
          backgroundWork.apply(sessionKey()!, message);
        }

        // A task the user stopped gets no follow-up turn from the CLI — only its
        // `stopped` notification — so when that was the last outstanding task
        // nothing will ever push the `result` the release below waits for, and
        // the process would sit until the idle ceiling. Release it here. A
        // completed task is different: the CLI relays its result in a turn of
        // its own, which closing stdin now would cut short. Nor while this turn
        // has started untracked work (a CronCreate, say): only its result's
        // Stop snapshot says whether that needs the process.
        if (
          heldForBackgroundWork
          && !backgroundWorkPending
          && message.type === 'system'
          && message.subtype === 'task_notification'
          && message.status === 'stopped'
          && !backgroundWork.hasOutstanding(sessionKey()!)
          && backgroundWork.crons(sessionKey()).length === 0
        ) {
          heldForBackgroundWork = false;
          releasePromptStream('last tracked task stopped');
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
            stopNoticeDeferred = false;
            settleTurn();
            abortedMidTurn = true;
            notifyAbortedOnce();
          } else if (!turnCompleteSent) {
            turnCompleteSent = true;
            ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
            settleTurn();
            // Only tracked tasks put off the notice: untracked work is scheduled
            // prompts (hours off, maybe) or a TaskCreate that never reports back.
            stopNoticeDeferred = stillOutstanding && stopNoticeWaitsForIdle(ws?.userId || null);
            if (!stopNoticeDeferred) {
              notifyStopped('completed');
            }
          } else if (stopNoticeDeferred && !stillOutstanding) {
            // The held notice stands in for "background work finished", once
            // the last tracked task has reported back.
            stopNoticeDeferred = false;
            notifyStopped('completed');
          } else if (heldForBackgroundWork && !stillOutstanding && backgroundWork.crons(sessionKey()).length === 0) {
            // A result after the turn already reported complete means the work we
            // held the process open for has finished and pushed a follow-up turn
            // — the last of it, when nothing else is still running. A scheduled
            // prompt's fire is such a turn too; only once none is left is the
            // work done.
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
          // reporting back, so it keeps a hold for untracked work (ScheduleWakeup,
          // CronCreate) — nothing else says when that is done.
          // Tracked tasks need no such help: the tracker knows exactly.
          const keepUntrackedHold: boolean = userTurn && heldForUntrackedWork;
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
            scheduleRelease();
          } else {
            // Either nothing was backgrounded, or the background work just
            // reported in — let the CLI exit now, as it always has.
            heldForBackgroundWork = false;
            releasePromptStream('turn end with nothing to hold');
          }
        } else if (idleReleaseTimer) {
          // Background activity after the turn — push the countdown back out.
          scheduleRelease();
        }
      } catch (error) {
        console.error(`[Claude SDK] Skipped a message (${message?.type}) for session ${sessionKey()}:`, errorMessage(error));
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (ownsEntry()) {
      removeSession(sessionKey()!);
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()!) : false;
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      if (wasAborted) {
        abortedMidTurn = true;
        notifyAbortedOnce();
      } else {
        notifyStopped('completed');
      }
    } else if (stopNoticeDeferred && !superseded && !wasAborted) {
      // The held work never reported and the process ended anyway (the
      // silence ceiling, say): the session is idle now.
      notifyStopped('completed');
    } else if (wasAborted) {
      // Stopped mid-turn, and the stream ended without a stopped `result`.
      notifyAbortedOnce();
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    if (!ownsProcess) {
      // A pushed message whose own setup failed (an unreadable attachment,
      // say): report it, and leave the process and its turn to their run.
      ws.send(createNormalizedMessage({ kind: 'error', content: errorMessage(error), sessionId: sessionId || null, provider: 'claude' }));
      return;
    }

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (ownsEntry()) {
      removeSession(sessionKey()!);
    }

    if (queryInstance && supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = (sessionKey() ? abortedSessionIds.delete(sessionKey()!) : false) || lastResultAborted;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error. It
      // is still a cancelled run, reported the same way as when the stream
      // ends after the interrupt.
      if (!turnCompleteSent) {
        abortedMidTurn = true;
      }
      notifyAbortedOnce();
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : (error as Error).message;

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
    releasePromptStream('run end');
    settleTurn();
  }
}

/**
 * Stops a run still setting up, which has no process yet: it is told not to
 * start one, and its input is let go so a send racing in takes the session
 * over instead of being pushed into a run that will never read it.
 * @param {Object} session - activeSessions entry with no instance yet
 */
function cancelSetup(session: ActiveSession) {
  if (!session.controls) {
    return;
  }
  session.controls.cancelledBeforeStart = true;
  session.controls.releaseInput('stop during setup');
  session.controls.markAborted();
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId: string) {
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
    const instance = session.instance;
    await Promise.allSettled(pending.map((uuid) => instance.cancelAsyncMessage?.(uuid)));

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
 * @returns {boolean} False when the session has no live process, or it is already ending
 */
function exitClaudeSDKSession(sessionId: string) {
  const session = getSession(sessionId);
  // Already ending: its entry stays until the run does.
  if (!session || (session.instance && supersededInstances.has(session.instance))) {
    return false;
  }
  if (!session.instance) {
    cancelSetup(session);
    return true;
  }
  // Its run loop winds down silently; the caller reports the end. The entry
  // stays until the run ends, so a send meanwhile takes the session over and
  // waits for this process to exit.
  supersededInstances.add(session.instance);
  session.controls?.releaseInput('/exit');
  session.instance.close?.();
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
 */
function listClaudeSDKBackgroundWork(): Array<{ sessionId: string; startedAt: number; tasks: BackgroundTaskSummary[]; crons: SessionCronSummary[] }> {
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
function acceptsClaudeSDKLiveInput(sessionId: string) {
  return Boolean(getSession(sessionId)?.controls?.isInputOpen());
}

/**
 * Delivers a user message into a session's running turn ("steering"): Claude
 * reads it at its next tool-call boundary and carries on with it in mind, with
 * nothing stopped. Written like any send pushed into the live process (see
 * `pushTurn`); a turn that ends before reading it runs it as the next turn on
 * the same process.
 *
 * Resolves false when the session has no live process taking input, or its
 * turn has already been reported complete — the message could only start a
 * new turn then, which is the caller's to send.
 * @param {string} sessionId - App session identifier
 * @param {string} command - The message text
 * @param {Object} options - `images`, `files` (verified descriptors) and `messageId`
 * @returns {Promise<boolean>} True once the message is on its way to the CLI
 */
async function steerClaudeSDKSession(sessionId: string, command: string, options: AnyRecord = {}) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || !session.instance || !session.controls?.isInputOpen()) {
    return false;
  }
  const messageId = typeof options.messageId === 'string' && options.messageId
    ? options.messageId
    : crypto.randomUUID();
  return session.controls.steer({ command, images: options.images, files: options.files, messageId });
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 *
 * The CLI acknowledges `stop_task` even when it stops nothing (seen with a
 * Monitor task, CLI 2.1.318), so the stop only counts once the task has left
 * the tracker; otherwise this throws and the user hears the stop failed.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @param {number} confirmMs - How long to wait for the task to settle
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
// A repeated ✕ joins the stop under way instead of sending stop_task again.
const pendingTaskStops = new Map<string, Promise<boolean>>();

function stopClaudeSDKTask(sessionId: string, taskId: string, confirmMs = 5000): Promise<boolean> {
  const key = `${sessionId}\u0000${taskId}`;
  const pending = pendingTaskStops.get(key);
  if (pending) return pending;
  const stop = runClaudeSDKTaskStop(sessionId, taskId, confirmMs)
    .finally(() => pendingTaskStops.delete(key));
  pendingTaskStops.set(key, stop);
  return stop;
}

async function runClaudeSDKTaskStop(sessionId: string, taskId: string, confirmMs: number): Promise<boolean> {
  const session = getSession(sessionId);
  const stopTask = session?.instance?.stopTask;
  if (!session || !stopTask || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  // Not awaited: the CLI may answer late or never, and the task leaving the
  // tracker is what counts, so one deadline covers both waits.
  let answered = false;
  let failed = false;
  let failure: unknown;
  stopTask.call(session.instance, taskId).then(
    () => { answered = true; },
    (error: unknown) => { answered = true; failed = true; failure = error; },
  );
  const deadline = Date.now() + confirmMs;
  while (backgroundWork.has(sessionId, taskId)) {
    if (failed) {
      throw failure;
    }
    if (Date.now() >= deadline) {
      throw new Error(answered
        ? `Claude Code acknowledged the stop, but background task "${taskId}" is still running.`
        : `Claude Code did not answer the stop of background task "${taskId}".`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId: string) {
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
function getClaudeSDKSessionStartTime(sessionId: string) {
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
function getPendingApprovalsForSession(sessionId: string) {
  const pending: AnyRecord[] = [];
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
function reconnectSessionWriter(sessionId: string, newRawWs: unknown) {
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
function runClaudeTurn(
  command: string,
  options: AnyRecord,
  ws: ClaudeRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<ProviderRunOutcome> {
  // One-shot callers (the agent API, commit messages) want the finished work,
  // background agents included, as on a process-scoped run.
  if (!options.settleAtTurnEnd) {
    return queryClaudeSDK(command, options, ws, context);
  }
  return new Promise<ProviderRunOutcome>((resolve, reject) => {
    queryClaudeSDK(command, options, ws, context, () => resolve()).then(resolve, reject);
  });
}

/**
 * SDK 0.3.311 ships `Query.prototype.askSideQuestion` without it in the SDK's
 * own typings (checked in node_modules/@anthropic-ai/claude-agent-sdk) — hence
 * the local types below rather than an imported one.
 */
type NativeSideQuestionResult = {
  response: string;
  synthetic: boolean;
  refusalFallback?: AnyRecord;
};

type NativeSideQuestionCapableInstance = {
  askSideQuestion: (
    question: string,
    options?: { signal?: AbortSignal },
  ) => Promise<NativeSideQuestionResult | null>;
};

/**
 * Asks a side question on the live query of `request.appSessionId`, when one
 * is up and ships the method, or on a read-only fork otherwise.
 *
 * Measured 2026-10-27 (`claude-measurement`, SDK 0.3.311, five calls each,
 * alternating): median response time, native vs the fork —
 *   mid-turn (process mid-generation):        native 1504 ms, fork 7476 ms
 *   background (held only for background work): native 2141 ms, fork 5016 ms
 * Native wins in both busy states, so the path taken here does not depend on
 * which one the process is in: any live query with the method answers
 * natively. Caveat: the CLI refused a foreground `sleep 240` during
 * measurement, so most "mid-turn" calls likely ran after the turn ended too
 * — the gap there may be narrower than measured, not wider.
 *
 * `liveTasks` for the fork path comes from this runtime's own background
 * work tracker, keyed by the app session id, so the fork's prompt can say
 * which of the session's own tasks are still running.
 */
async function askSideQuestion(
  request: SideQuestionRequest,
  sink: SideQuestionSink,
  context: ProviderRuntimeContext,
): Promise<SideQuestionOutcome> {
  const session = getSession(request.appSessionId);
  // The SDK does not type this method (see above), so the instance is read
  // through the local type rather than `ClaudeQuery`.
  const instance = session?.instance as NativeSideQuestionCapableInstance | null | undefined;
  const controls = session?.controls;

  // A session whose stdin was already released still has `instance` around,
  // but a write into its input stream is silently dropped rather than
  // answered. The fork path below spawns its own process instead, so it is
  // the only one that can still reach this session's transcript.
  if (instance && controls?.isInputOpen() && typeof instance.askSideQuestion === 'function') {
    try {
      const result = await instance.askSideQuestion(request.question, { signal: request.signal });
      const response = result?.response;
      if (typeof response === 'string' && response.length > 0) {
        sink.delta(response);
        return { status: 'done', answer: response };
      }
      return { status: 'error', error: 'Claude returned no answer.', answer: '' };
    } catch (error) {
      // `request.signal` is what `dismiss` aborts to end this ask at once —
      // a deliberate drop, never retried. Input let go while the question
      // was in flight (the turn ended with nothing to hold, a takeover, the
      // silence ceiling) is the CLI cancelling it for another reason — most
      // of all "Side question cancelled" — so it gets one more try on the
      // read-only fork instead. A plain failure with input still open is
      // not retried.
      if (!request.signal?.aborted && !controls.isInputOpen()) {
        return askClaudeSideQuestion(request, sink, {
          createQuery: context.createQuery,
          liveTasks: backgroundWork.outstanding(request.appSessionId),
        });
      }
      return { status: 'error', error: errorMessage(error), answer: '' };
    }
  }

  return askClaudeSideQuestion(request, sink, {
    createQuery: context.createQuery,
    liveTasks: backgroundWork.outstanding(request.appSessionId),
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
  askSideQuestion,
  steer: steerClaudeSDKSession,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  steerClaudeSDKSession,
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
