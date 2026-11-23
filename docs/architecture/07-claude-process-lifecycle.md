# The Claude CLI process lifecycle

*How the Claude runtime keeps one CLI process per session, when a send is pushed into it
and when it takes the session over. Everything here lives in
`server/modules/providers/list/claude/claude-runtime.provider.js` unless a path says
otherwise; the tests are in `server/modules/providers/tests/claude-runtime-hold.test.ts`.
The requirement is [#69](https://github.com/jgong5/claudecodeui/issues/69); the evidence
is [#67](https://github.com/jgong5/claudecodeui/issues/67).*

## In one paragraph

A run (`queryClaudeSDK`) owns one CLI process and one `activeSessions` entry, keyed by the
app session id. The entry carries the run's `controls`. Its prompt stream (`createInputStream`)
stays open after a turn's `result` while background work is outstanding, so the CLI keeps
running. A later send asks `controls.isInputOpen()`. When open, `pushTurn` writes the message
into the live process. When closed, the send takes the session over (`takeOver`). That
starts a new process, after the old one has exited.

## Why a send fails to push

A send is pushed only while the entry exists and its input is open. #67 names the two ways
that can fail.

**(a) Input released while work is outstanding.** Input is released (`releasePromptStream`)
on these triggers:

| Trigger | Where |
| --- | --- |
| turn end with nothing to hold | the `result` branch, when `holdForTurn` is false |
| last tracked task stopped | the `task_notification` / `stopped` branch |
| silence ceiling | `scheduleRelease` timer (`BG_WAIT_CEILING_MS`, off at `0`) |
| supersede | `addSession`, superseding branch |
| `/exit` | `exitClaudeSDKSession` |
| stop during setup | `cancelSetup` |
| run end | the `finally` of `queryClaudeSDK` |

The first two read `createBackgroundWorkTracker`. The table below shows what each kind in
#69 sends and what `backgroundWork.apply` does with it on CLI 2.1.330. Spikes #71 and #72
measured the background Bash, agent and Monitor rows (see Dependencies). The workflow row
rests on the tracker's own comment (`createBackgroundWorkTracker`, checked against a real
query on SDK 0.3.165). The `CronCreate` row rests on `session_crons` in the 2.1.330 `Stop`
hook input schema.

| Kind | Stream | `apply` |
| --- | --- | --- |
| background Bash | `task_started` `local_bash`, `tool_use_id` = the Bash call | tracked, `toolName: Bash` |
| agent | `task_started` `local_agent`, `tool_use_id` = the Agent call | tracked, `toolName: Agent` |
| agent resumed via `SendMessage` | `task_started` `local_agent`, the first run's `task_id`, `tool_use_id` = the `SendMessage` call | tracked, `toolName: SendMessage` |
| same, its subagent's foreground Bash | `task_started` `local_bash`, `tool_use_id` = a call inside the agent | tracked, `nested` |
| same, while running | `task_progress` | ignored |
| same, at its end | `task_updated` with patch `completed`, then `task_notification` | removed by the first |
| workflow | `task_started` `local_workflow` | tracked |
| Monitor | `task_started` `local_bash`, `tool_use_id` = the Monitor call | tracked, `toolName: Monitor` |
| `CronCreate` | no task events; the `Stop` hook's `session_crons` | `setCrons`, held by `holdForSchedule` |

What `apply` drops is a `task_started` with no `tool_use_id` (the CLI's own housekeeping) and
a non-terminal `task_updated`. Neither is work a user started. So at the `result` of a turn
that leaves any of these kinds running, `stillOutstanding` or `holdForSchedule` is true and
the turn holds, and the stopped-task release waits for the last one. **No kind goes untracked
on 2.1.330**: a run on its own holds for each, and its tests pin today's behaviour (Ruling on
#70).

**The defect in path (a) is a superseded run writing to the shared key.** The runtime keeps
one tracker, keyed like `activeSessions`. The superseding branch of `addSession` clears the
key, but the superseded run's loop keeps calling `backgroundWork.apply(sessionKey(), ...)`
for its process's messages, and its `Stop` hook keeps calling `setCrons`. A resume reuses
the agent's `task_id` (#71). So when the old process reports that agent ended
(`task_notification`), the tracker drops the task the new process is running under the
same id. At the new run's next `result`, `hasOutstanding` is false and input is released.
The old `Stop` hook can likewise replace the new process's crons. This fits #67's repeated
takeovers: each takeover resumes the agents, and the old process's notices release the new
one. Decision 2's wait narrows the window but does not close it. Node fires a child's
`exit` while its stdout may still hold unread lines
([`child_process` `exit`](https://nodejs.org/api/child_process.html#event-exit)), and the
old loop handles those after the new run has started.

**(b) `removeSession` dropping a live entry.** `removeSession` is called at the run loop's end,
in the run's `catch`, on a stop during setup, and by `exitClaudeSDKSession`. These can drop an
entry while its process lives:

1. **A throw while handling one message.** Any throw in the loop body (`normalizeMessage`, a
   writer, the hold bookkeeping) leaves the `for await`. The `catch` then removes the entry
   and the `finally` releases input. Leaving the loop runs the SDK's cleanup
   (`sdk.mjs: Query.readSdkMessages`, then `performCleanup`), which calls
   `ProcessTransport.close`: the process and its background work die within about 7 s. A
   send in that window finds no entry: the runtime alone would build a second query, and the
   gateway refuses the send (below). This is the only caller that drops an entry
   still taking input with work outstanding. The SDK side ends the loop only at exit
   (`sdk.mjs: ProcessTransport.readMessages` awaits `waitForExit`, then throws `exitError`).
2. **`/exit`.** `exitClaudeSDKSession` removes the entry right after `Query.close()`, which
   SIGTERMs only after a 2 s grace and SIGKILLs 5 s later (`sdk.mjs: ProcessTransport.close`).
3. **Ownership matched on `instance`.** The `catch` removes when
   `getSession(key)?.instance === queryInstance`, and `null === null` holds. A run that fails
   in setup after a stop removes the entry of the run that took the session over.

Seen from the gateway, path (b) beside a live process refuses the send rather than starting a
second process. `dispatchRun` (`chat-websocket.service.ts`) asks `isSessionHeldExternally`
first. `listExternalClaudeCliSessions` (`claude-cli-liveness.service.ts`) counts every live CLI
in `~/.claude/sessions` whose session has no runtime entry. The CLI writes that file for
SDK-spawned processes too: the one for #67's pid 1057024 reads `entrypoint: sdk-ts`. So #67's
second processes came through an entry whose input was closed, and the superseded run's
writes above are one way it closes. The release log line names its trigger the next time it
happens.

## Scenarios

### A send while work is outstanding is pushed, path (a), each kind (A2)

```mermaid
sequenceDiagram
  participant G as Gateway
  participant R as queryClaudeSDK
  participant T as backgroundWork
  participant C as CLI
  C->>R: tool_use and task events for the kind
  R->>T: apply
  C->>R: result
  R->>T: hasOutstanding or crons
  T-->>R: true
  R->>R: hold input open
  G->>R: send
  R->>C: pushTurn writes the message
```

The test, one per kind: emit the kind's stream from the table above, then `result`, then
`send`. It asserts one query and that the last input is the message with `priority: 'next'`.
It passes on `main` today.

### #67's sequence: a send after a takeover whose agent the new process resumes, path (a) (A2)

```mermaid
sequenceDiagram
  participant G as Gateway
  participant O as Old run
  participant N as New run
  participant T as backgroundWork
  G->>N: send, old input closed
  N->>O: addSession supersedes
  N->>T: SendMessage resume, task_started T
  O->>O: task_notification T, not the owner, skip apply
  O->>O: Stop hook, not the owner, skip setCrons
  G->>N: send, pushed
  N->>T: result, hasOutstanding T
  T-->>N: true, hold input open
  G->>N: send
  N->>N: pushTurn writes the message
```

The test: run 1's scripted turn ends with nothing outstanding, so its input closes while its
stream stays open. A send takes over; run 1 spawned no child, so it waits on nothing. Run
2's stream sends a `SendMessage` call, a `task_started` with task id T for it, its `Stop`
hook with one cron, and `result`, so it holds. Run 1's stream then sends a `task_notification` for T, run 1's `Stop` hook reports
no crons, and run 1's stream ends. A send is pushed, and its turn's `result` comes. A
fourth send is pushed too. The test asserts two queries in all, and that
`listClaudeSDKBackgroundWork` still lists T and the cron. With decision 8 reverted it fails:
T and the cron are gone, the third send's `result` releases input, and the fourth send
builds a third query.

### A throw while work is outstanding does not end the run, path (b), each kind (A2)

```mermaid
sequenceDiagram
  participant G as Gateway
  participant R as queryClaudeSDK
  participant C as CLI
  C->>R: the kind's launch, then result
  R->>R: hold input open
  C->>R: a message whose handling throws
  R->>R: log it, keep reading
  G->>R: send
  R->>C: pushTurn writes the message
```

The test, one per kind: the launch as in path (a), then the test makes
`context.normalizeMessage` throw for one message, then `send`. It asserts one query and the
pushed message. On `main` it fails: the throw ends the run, the entry goes, and the send
builds a second query.

### A setup failure after a stop keeps the takeover's entry, path (b) (A2)

```mermaid
sequenceDiagram
  participant G as Gateway
  participant A as Run 1, in setup
  participant B as Run 2, in setup
  G->>A: send
  G->>A: stop, cancelSetup
  G->>B: send, takes over the entry
  A->>A: setup throws, catch
  A->>A: entry holds run 2's controls, keep it
  G->>B: send, queued behind run 2's prompt
```

The test: run 1's and run 2's `resolveResumeModel` each wait on a promise the test holds.
Send 1, stop it (`abortClaudeSDKSession`), send 2. The test then rejects run 1's promise,
sends a third message and lets run 2's setup finish. It asserts one query, whose input holds
run 2's prompt and then the third message. With decision 5 reverted it fails: run 1's
`catch` matches `null` to `null` and removes run 2's entry, so the third send starts a
second query.

### A takeover never leaves two processes (A3)

```mermaid
sequenceDiagram
  participant G as Gateway
  participant N as New run
  participant O as Old run
  participant P as Old child
  G->>N: send, old input closed
  N->>O: addSession supersedes
  O->>P: interrupt, ignored
  O->>P: release input, SIGTERM
  P-->>N: exit
  N->>N: createQuery, spawn
```

The test's scripted query calls the `spawnClaudeCodeProcess` the runtime set, with
`process.execPath` and a script that keeps running after stdin ends; the scripted
`interrupt()` does nothing. The query ends its stream when that child exits, as the SDK's
does. The turn ends with nothing outstanding, so
input closes while the child lives. A `send` then takes over. The test asserts that the
child got SIGTERM (`signalCode`) and that the second `createQuery` came after its `exit`.
With decisions 1 and 2 reverted it fails: no child is spawned or signalled, and the second
query is built at once.

### `/exit`, then a send

```mermaid
sequenceDiagram
  participant G as Gateway
  participant R as Run
  participant P as Child
  G->>R: exit
  R->>R: release input
  R->>P: Query.close
  G->>R: send, input closed
  R->>P: SIGTERM, await exit
  P-->>R: exit
  R->>R: new run spawns
```

The test uses the A3 child. Run 1's turn holds for a tracked task, so input is open. `/exit`
is called, and the scripted `close()` leaves the child alive, as the SDK's does for 2 s. A
send follows. The test asserts the child got SIGTERM and the second `createQuery` came after
its `exit`. With decision 6 reverted it fails: `/exit` removes the entry, so the send builds
the second query at once and nothing signals the child.

### The log lines (A4)

```mermaid
sequenceDiagram
  participant R as queryClaudeSDK
  participant L as console.log
  R->>L: takeover, with the previous entry's state
  R->>L: input released, trigger and outstanding tasks
  R->>L: removeSession
```

The test mocks `console.log`. It sets `BG_WAIT_CEILING_MS` to 20 ms, holds the session for a
tracked Monitor, and lets the ceiling fire. It then ends the stream. It asserts one takeover
line, one release line naming `silence ceiling` and the Monitor's task id, and one
`removeSession` line.

## Decisions

1. **The runtime spawns the CLI itself.** `sdkOptions.spawnClaudeCodeProcess` makes the
   same `spawn` call the SDK makes (`stdio` pipe, pipe, ignore; its `cwd`, `env` and
   `signal`), and keeps the child on `controls` with a promise settled by its `exit`, or by
   its `error` when the spawn fails. Basis: code,
   `sdk.mjs: ProcessTransport.spawnLocalProcess` is one `spawn`, and `sdk.d.ts:
   Options.spawnClaudeCodeProcess` takes any `SpawnedProcess`, which a `ChildProcess` is.
   Rejected: supersede through `Query.close()`. It sends SIGTERM only inside the SDK, 2 s
   later, where the hold tests' scripted query cannot see it.
2. **Supersede sends SIGTERM at once and the new run waits for the exit.** The superseding
   branch of `addSession` calls `interrupt()` without awaiting it, releases input, and
   SIGTERMs the child if it has not exited. It returns the child's exit promise, which
   `takeOver` keeps and the run awaits just before `createQuery`. Basis: code,
   `Query.interrupt()` is a control request that a stuck CLI may never answer, and it never
   ends a held process. Rejected: SIGTERM once the interrupt settles, which may never happen.
3. **No SIGKILL.** Basis: principle, no generality for speculative needs (default
   principles). The CLI exits 143 on SIGTERM (#67). Rejected: escalating after a timeout,
   which guards a CLI that ignores SIGTERM, which nothing has shown.
4. **A throw while handling one message is logged and the loop goes on.** The loop body sits
   in a `try` inside the `for await`. The catch writes a `console.error` line and reads the
   next message. With that, the run ends only when the SDK stream does, at the process's
   exit, and one bad message no longer costs the session its background work. Basis: code,
   path (b) item 1 above. Rejected: keeping the entry until the child's exit but ending
   the run. The `finally` would still release input, so the send takes over
   instead of being pushed, and A2 fails for path (b).
5. **Removal stays at the run's end, matched on `controls`.** The loop end and the `catch`
   remove only when `getSession(key)?.controls === controls`, as the setup-cancel path
   already does. Basis:
   code, path (b) item 3. With decision 4 the run's end is the process's exit. Rejected: a
   removal on the child's `exit` event, a second site for the same moment.
6. **`/exit` releases input and closes the query, and leaves removal to the run's end.** A
   second `/exit` returns false once the instance is in `supersededInstances`. Basis: code,
   path (b) item 2. The existing test "Stop interrupts the turn and cancels queued pushes;
   /exit closes the process" expects that false. Rejected: a new `status` value.
   `getClaudeSDKSessionStartTime` and the supersede check read `status === 'active'`, so the
   dying process would look external and a takeover would skip its SIGTERM.
7. **No tracker change for any kind: path (a) gets tests.** The resumed agent and Monitor
   are tracked (#71, #72).
   An agent launched by an earlier process and resumed in this one has an id new to the
   CLI's task registry, and the registry's register function sends `task_started` for any
   new id (CLI 2.1.330 bundle).
   The comments on `sawTaskEventThisTurn`, `keepUntrackedHold` and `DEFERRED_WORK_TOOLS` that
   call Monitor untracked are corrected. So is the tracker's note that a foreground Bash
   emits nothing (a subagent's does). Monitor stays in `DEFERRED_WORK_TOOLS` as the fallback
   for a stream with no task events. Basis: the spikes, and Ruling (a) on #70. Rejected: a
   third spike on the cross-process resume, since it goes through the same register call.
8. **A run writes to the tracker only while it owns the session's entry.** The loop's
   `backgroundWork.apply` and the `Stop` hook's `setCrons` are skipped once
   `getSession(sessionKey())?.controls !== controls`, the same test decision 5 uses for
   removal. Basis: code, the shared key and the superseded run's writes under path (a); the
   superseding branch of `addSession` clears the key only once. Rejected: rely on decision 2's
   wait, which leaves the lines read after the old child's `exit`. Rejected too: key the
   tracker by run, which `listClaudeSDKBackgroundWork` and `stopClaudeSDKTask` read by
   session key.
9. **Logs: `console.log`, prefix `[Claude SDK]`, one line each.**
   - Input released: logged once, when input actually closes. It carries the session key,
     the trigger from the table above, and the session's tasks from `backgroundWork.list()`.
   - `removeSession`: logged inside `removeSession`, so every caller gets it.
   - Takeover: logged in `takeOver`, with the previous entry's state (none, input closed,
     setup), which tells path (a) from path (b).

   Basis: code, the runtime already logs with `console.log` and no logger module exists under
   `server/`. Principle: follow the project's existing conventions. Rejected: a logger
   module, a new module for a few lines.
10. **One task.** Every change is in `queryClaudeSDK` and the functions beside it, so two
   tasks would conflict on each hunk. Basis: `split_loc` is 1000 and the estimate is far
   below. Rejected: logs as a task of their own.

## Simpler alternative

Logs only, as #67's own fix order has it: log, then fix what the log names. It fails A3, since
nothing stops a superseded process. It also fails A2 for path (b) and for #67's sequence,
since nothing would make those tests pass. The next simplest supersedes through
`Query.close()` and waits on the old run's end, with no spawn hook (decision 1). It fails A3
as checked: the SIGTERM happens inside the SDK 2 s later, and the scripted query the hold
tests use cannot observe it.

## Low confidence

None.

## Dependencies

- [#71](https://github.com/jgong5/claudecodeui/issues/71): a `SendMessage` resume starts a
  tracked task. At turn 2's `result`, `hasOutstanding` was true in 5 of 5 runs. Spike PR
  [#74](https://github.com/jgong5/claudecodeui/pull/74) at
  `f7711d5c1d0bbf7a3fdc494b1263504068398900`, closed unmerged.
- [#72](https://github.com/jgong5/claudecodeui/issues/72): Monitor starts a tracked task.
  The tracker held a `toolName: Monitor` task at `result` in 10 of 10 runs. Spike PR
  [#73](https://github.com/jgong5/claudecodeui/pull/73) at
  `f9465ea877b3746449c000f67d4a115d6be574e7`, closed unmerged.
- No sync issue: nothing here is upstream-only.

## Summary

**Deliverable.** One process per Claude session. A send with live background work is pushed,
for every kind in #69. Each input release, `removeSession` and takeover is logged.

**Scope and non-goals.** As #69. Other providers, transcript load time, client UI, the meaning
of `BG_WAIT_CEILING_MS` and the live check stay out. Out too: stderr piping under
`DEBUG_CLAUDE_AGENT_SDK`, which the SDK's own spawn does and the hook leaves out. The
existing tests' `holdForMonitor` fixture, a Monitor with no task events, stays: it exercises
the static rule.

**Changes per file.**

- `claude-runtime.provider.js`
  - `queryClaudeSDK` gets the spawn hook, the per-message `try`, the release trigger
    argument and log, and `takeOver`'s wait and log.
  - Removal at the loop end and in the catch is matched on `controls`, and so are the
    loop's `backgroundWork.apply` and the `Stop` hook's `setCrons`.
  - `addSession`: SIGTERM in its superseding branch, and it returns the exit promise.
  - `removeSession`: its log line.
  - `exitClaudeSDKSession`: release, close, no removal, false when already ending.
  - The comment corrections of decision 7.
- `claude-runtime-hold.test.ts`: a table of the kinds in #69, each run through a path (a)
  test and a path (b) test, plus the tests of each scenario above: #67's sequence, the setup
  failure after a stop, A3, `/exit` then a send, and A4. Existing tests unchanged.

**Acceptance.** A1 is the gate. A2: one test per kind and path. The path (b) tests fail with
decision 4 reverted. The path (a) tests pass on `main` (Ruling on #70). #67's sequence fails
with decision 8 reverted, the setup failure with decision 5, and `/exit` then a send with
decision 6. A3: the takeover test, failing with decisions 1 and 2 reverted. A4: the log
test.

**Task.** One task, file set the two files above. Estimate: code about 115 added, 190 moved
(the loop body's new indent) and 15 deleted; tests about 400 added.
