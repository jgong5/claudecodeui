import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { getClaudeSDKSessionStartTime } from '@/modules/providers/list/claude/claude-runtime.provider.js';

/** One live registry entry, keyed by Claude's own session id as the registry records it. */
type LiveRegistryEntry = {
  providerSessionId: string;
  startedAt: number;
  busy: boolean;
};

/**
 * One Claude CLI process alive on a session CloudCLI knows, that this
 * server's runtime does not hold: a terminal `claude`, an IDE, or the Shell
 * view's own `claude`. `startedAt` is when the process started; `busy` says
 * whether it is producing a response rather than waiting for input.
 */
type ExternalClaudeCliSession = {
  sessionId: string;
  startedAt: number;
  busy: boolean;
};

/**
 * Claude Code keeps one file per running session here, named `<pid>.json`.
 * The directory belongs to the CLI, not to CloudCLI: it is only ever read.
 */
const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');

/**
 * Upper bound on registry files inspected per poll.
 *
 * The running-sessions endpoint is polled continuously, so a directory left
 * full of stale files by repeated crashes must not turn every poll into
 * unbounded filesystem work. Real installations hold a handful of entries.
 */
const MAX_REGISTRY_FILES = 256;

/**
 * Whether `pid` is still the process the registry recorded.
 *
 * A registry file outlives a crash, so its mere presence proves nothing. The
 * signal-0 probe answers "does this pid exist" (EPERM means it exists but is
 * owned by someone else, which still counts), and on Linux the recorded
 * `procStart` is compared against the kernel's start-time for that pid so a
 * reused pid cannot be mistaken for the original process.
 */
async function isRecordedProcessAlive(pid: number, procStart: unknown): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') {
      return false;
    }
  }

  if (process.platform !== 'linux' || typeof procStart !== 'string' || !procStart) {
    return true;
  }

  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces, so the
    // fields are counted from the last ')'. starttime is the 22nd field
    // overall, i.e. the 20th of what follows the comm field.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] === procStart;
  } catch {
    // No procfs entry means the process is gone between the two checks.
    return false;
  }
}

/** Reads one registry file, returning null for anything that is not a live session. */
async function readLiveRegistryEntry(filePath: string): Promise<LiveRegistryEntry | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable, half-written or malformed entries are simply not evidence
    // of a running session.
    return null;
  }

  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return null;
  }

  const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const pid = typeof record.pid === 'number' ? record.pid : NaN;
  if (!providerSessionId || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  if (!(await isRecordedProcessAlive(pid, record.procStart))) {
    return null;
  }

  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.now();
  return { providerSessionId, startedAt, busy: record.status === 'busy' };
}

/**
 * Lists the Claude CLI processes alive on CloudCLI sessions that this
 * server's runtime does not hold, busy or waiting for input.
 *
 * Used by the providers module's sessions service, so the running-sessions
 * poll reports a session held elsewhere, and by the Claude history reader,
 * which reads a background launch made after the process started as still
 * running. An idle process counts too: its turn has ended but its background
 * work may not have. A process this server's runtime holds is left out: the
 * runtime reports on it itself, and it keys its process map by the app
 * session id or the provider-native one, so both are asked. Liveness is
 * ephemeral, so it is recomputed on every read instead of being cached.
 */
export async function listExternalClaudeCliSessions(): Promise<ExternalClaudeCliSession[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(registryDirectory());
  } catch {
    // No registry directory at all is the normal case for an install that has
    // never run the CLI, and an unreadable one is not worth failing a poll for.
    return [];
  }

  const registryFiles = entries.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRY_FILES);
  const liveEntries = await Promise.all(
    registryFiles.map((entry) => readLiveRegistryEntry(path.join(registryDirectory(), entry))),
  );

  const external: ExternalClaudeCliSession[] = [];
  for (const live of liveEntries) {
    const session = live ? sessionsDb.getSessionByProviderSessionId(live.providerSessionId) : null;
    if (
      !live
      || !session
      || getClaudeSDKSessionStartTime(session.session_id) !== null
      || getClaudeSDKSessionStartTime(live.providerSessionId) !== null
    ) {
      continue;
    }
    external.push({ sessionId: session.session_id, startedAt: live.startedAt, busy: live.busy });
  }
  return external;
}

/**
 * Whether a Claude process this server's runtime does not hold is alive on
 * the session, busy or idle.
 *
 * Used by the websocket module's chat gateway, which refuses to start a second
 * process resuming the same transcript beside it, and by the sessions service,
 * which refuses to delete the session under it.
 */
export async function isSessionHeldExternally(sessionId: string): Promise<boolean> {
  return (await listExternalClaudeCliSessions()).some((live) => live.sessionId === sessionId);
}
