---
repo: jgong5/claudecodeui
integration_branch: main
gate_task: npm run typecheck && npm run lint && npm test && npm run test:client
design_entry: docs/architecture/README.md
---

Backend code under `server/` follows `.agents/skills/backend-module-standards/SKILL.md`;
frontend code under `src/` follows `.agents/skills/frontend-module-standards/SKILL.md`
(see `AGENTS.md`).

Run the gate from a tree outside the OS temp directory: the read-only-roots and
file-tree tests treat anything under `os.tmpdir()` as inside a read-only root, so a
tree under `/tmp` fails three of them.

Never deploy or restart the `cloudcli` service: it runs the sessions agents work in.
