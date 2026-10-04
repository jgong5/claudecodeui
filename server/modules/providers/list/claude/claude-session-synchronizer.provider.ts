import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { SessionNameSource } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyModifiedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

const FALLBACK_SESSION_NAME = 'Untitled Claude Session';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName: string;
  naming: { nameSource: SessionNameSource; lastCustomTitle: string | null };
};

type TranscriptTitles = {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  /** Every `ai-title` and `last-prompt`, including superseded ones. */
  computedTitles: string[];
};

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyModifiedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
        parsed.naming
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const timestamps = await readFileTimestamps(filePath);
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
      parsed.naming
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file and decides
   * its name against the row's `name_source`.
   *
   * A `custom-title` that differs from the last one applied is a newer CLI
   * `/rename` and always wins. Other titles only replace `derived` names, so
   * a rename made in the app survives until the next CLI rename.
   *
   * The row is read after every await, and callers write it straight back,
   * so a rename made in the app cannot land between the read and the write.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    const titles = await this.extractSessionTitles(filePath, parsed.sessionId);
    const historyName = nameMap.get(parsed.sessionId);
    const customTitle = titles.customTitle ?? null;

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingName = existingSession?.custom_name || null;

    let nameSource = existingSession?.name_source ?? null;
    if (existingSession && !nameSource) {
      // A row from before `name_source` existed: a name that matches one of
      // this transcript's own titles was computed, anything else was typed.
      // Older titles count too: such a row kept the title it was first given.
      const derivedCandidates = [...titles.computedTitles, historyName]
        .filter((title): title is string => Boolean(title?.trim()))
        .map((title) => normalizeSessionName(title, FALLBACK_SESSION_NAME));
      const isDerived = !existingName
        || existingName === FALLBACK_SESSION_NAME
        || derivedCandidates.includes(existingName);
      if (!isDerived) {
        // Record the current custom-title as seen, so only a later rename
        // in the CLI replaces the name.
        return {
          ...parsed,
          sessionName: existingName,
          naming: { nameSource: 'web', lastCustomTitle: customTitle },
        };
      }
      nameSource = 'derived';
    }

    const lastCustomTitle = existingSession?.last_custom_title ?? null;
    if (customTitle && customTitle !== lastCustomTitle) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(customTitle, FALLBACK_SESSION_NAME),
        naming: { nameSource: 'cli', lastCustomTitle: customTitle },
      };
    }

    const naming = { nameSource: nameSource ?? 'derived', lastCustomTitle };
    if (existingName && naming.nameSource !== 'derived') {
      return { ...parsed, sessionName: existingName, naming };
    }

    const derivedTitle = titles.aiTitle || titles.lastPrompt || historyName;
    return {
      ...parsed,
      // A derived app name outlives a transcript that has no title yet.
      sessionName: derivedTitle
        ? normalizeSessionName(derivedTitle, FALLBACK_SESSION_NAME)
        : existingName ?? FALLBACK_SESSION_NAME,
      naming,
    };
  }

  /**
   * Returns the last `custom-title` (a manual `/rename`), `ai-title` and
   * `last-prompt` of one session's transcript, plus every `ai-title` and
   * `last-prompt` it holds.
   *
   * Scans forward keeping the last match of each event type. Claude writes
   * `custom-title` immediately before `ai-title`, so a reverse scan that
   * stopped at its first hit would always lose the manual rename.
   *
   * Returns no titles on a missing or unreadable file so sync can continue.
   */
  private async extractSessionTitles(
    filePath: string,
    sessionId: string
  ): Promise<TranscriptTitles> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      let foundCustomTitle: string | undefined;
      let foundAiTitle: string | undefined;
      let foundLastPrompt: string | undefined;
      const computedTitles: string[] = [];

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;

        if (eventSessionId !== sessionId) {
          continue;
        }

        if (eventType === 'custom-title') {
          const title = typeof data.customTitle === 'string' ? data.customTitle : undefined;
          if (title?.trim()) {
            foundCustomTitle = title;
          }
        } else if (eventType === 'ai-title') {
          const title = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
          if (title?.trim()) {
            foundAiTitle = title;
            computedTitles.push(title);
          }
        } else if (eventType === 'last-prompt') {
          const prompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
          if (prompt?.trim()) {
            foundLastPrompt = prompt;
            computedTitles.push(prompt);
          }
        }
      }

      return {
        customTitle: foundCustomTitle,
        aiTitle: foundAiTitle,
        lastPrompt: foundLastPrompt,
        computedTitles,
      };
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return { computedTitles: [] };
  }
}
