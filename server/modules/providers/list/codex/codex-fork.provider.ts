import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { IProviderFork } from '@/shared/interfaces.js';

/**
 * Branches a Codex conversation into an independent thread.
 *
 * `thread/fork` writes a real rollout with its own thread id and a
 * `forked_from_id` back-reference, which is what makes the copy resumable
 * rather than an inert duplicate of the file.
 *
 * Codex's unit is a turn, not a row: `upToAnchorId` names the last turn to
 * keep, and the cut is inclusive of it.
 */
export class CodexForkProvider implements IProviderFork {
  async forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }> {
    // `title` is deliberately not forwarded. The sidebar name lives in this
    // app's own session row, and naming the thread inside Codex would mean a
    // second call that could fail after the fork already succeeded.
    const fork = await codexAppServer.forkThread({
      threadId: input.providerSessionId,
      lastTurnId: input.upToAnchorId,
      cwd: input.projectPath,
    });

    // The path is the one the server reported and already confirmed on disk,
    // not one derived from the source: a fork lands in today's date directory
    // rather than beside the transcript it was copied from.
    return { providerSessionId: fork.threadId, jsonlPath: fork.path };
  }
}
