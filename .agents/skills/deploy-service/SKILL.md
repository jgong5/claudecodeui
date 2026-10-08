---
name: deploy-service
description: Deploy or update the CloudCLI web UI as the `cloudcli` systemd service on a Linux host. Use when installing it on a new machine, or when shipping a new build of this checkout to the running service.
---

# Deploy the CloudCLI service

`scripts/install-service.sh` does the whole job, fresh host or update: installs Node (major from `.nvmrc`) and Claude Code under `~/.local` if missing, builds and globally installs this checkout, writes `~/.cloudcli/start.sh` and `/etc/systemd/system/cloudcli.service`, then restarts the service. Flags are in `--help`; they persist in `~/.cloudcli/service.conf`, so an update is a bare re-run.

1. Check out the commit to deploy (normally `main`) and run the script from that checkout. On a fresh host, pass `--env-file` pointing at the bash file that exports the `ANTHROPIC_*` variables; the script references that file and never copies the secrets.
2. Done when the script prints the URL. When it says "restarts in 20s", this session lives inside the service and ends with the restart: report the outcome before then.

The first browser visit on a new host asks for a password; that creates `~/.cloudcli/auth.db`.
