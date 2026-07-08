# Deploying the always-on PolicyGuard provider to Fly.io

This runs the PolicyGuard provider agent 24/7 on Fly.io as a worker, so it stays
online and hireable without a terminal open on your laptop. The process
auto-reconnects after dropped connections, and the CROO SDK key exists **only**
as a Fly secret — never in git, never in the image, never pasted to anyone.

## What's in this repo for deployment

| File            | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `src/serve.ts`  | Resilient entrypoint: supervises `start()`, auto-reconnects, stays alive |
| `Dockerfile`    | `node:20-slim`, two-stage build, runs `node dist/serve.js` as non-root  |
| `fly.toml`      | Worker config — no ports, one always-running machine, `iad` region      |
| `.dockerignore` | Keeps `node_modules`, `.env`, `*.log`, `dist`, `.git` out of the image  |

The app reads three environment variables **by name only**: `CROO_API_URL`,
`CROO_WS_URL`, `CROO_SDK_KEY`. The requester key is not used by the provider.

## How resilience works

The CROO SDK's WebSocket already reconnects transient drops on its own
(exponential backoff capped at 30s, indefinitely). `serve.ts` adds a supervisor
around it for the two cases the SDK does not cover:

1. **Boot-time connect failure** — retries with backoff instead of crash-exiting.
2. **Terminal stream error** (e.g. duplicate-key policy violation, which the SDK
   stops reconnecting on) — detected by polling `stream.err()`, then torn down
   and reconnected.

It runs as a pure worker (no HTTP server) and shuts down cleanly on `SIGTERM`
(Fly deploys/stops) and `SIGINT` (local `Ctrl+C`).

---

## Deploy steps

Legend: **[YOU]** = you run it in your own terminal (auth / secrets are yours
alone). **[AUTOMATED]** = already done in this branch's files; nothing to run.

### 0. [AUTOMATED] App files
`Dockerfile`, `fly.toml`, `.dockerignore`, and `src/serve.ts` are in this branch.
No secret is in any of them.

### 1. [YOU] Install flyctl and log in (browser)
```powershell
# Windows PowerShell
iwr https://fly.io/install.ps1 -useb | iex
```
```bash
fly auth login          # opens a browser to authenticate
```

### 2. [YOU] Create the app
```bash
fly apps create policyguard-croo
```
> **App names are globally unique.** If `policyguard-croo` is taken, this command
> fails — pick another name (e.g. `policyguard-croo-bja`) and change the single
> `app = "..."` line in `fly.toml` to match before continuing.

### 3. [YOU] Set the secrets — YOURS ONLY
Paste the real values **only** into your own terminal. Do not put them in any
file, and do not paste the key into this chat.
```bash
fly secrets set \
  CROO_API_URL="https://<the CROO API base URL>" \
  CROO_WS_URL="wss://<the CROO WebSocket URL>" \
  CROO_SDK_KEY="croo_sk_<your provider key>" \
  -a policyguard-croo
```
Verify they exist (this prints names and digests only, never values):
```bash
fly secrets list -a policyguard-croo
```

### 4. [YOU] Deploy
```bash
fly deploy -a policyguard-croo
```

### 5. [YOU] Pin exactly one always-running machine
A deploy provisions one machine; this makes it explicit and guards against
accidental scale-to-zero. (The worker has no services, so nothing auto-stops it.)
```bash
fly scale count 1 -a policyguard-croo
```

### 6. [YOU] Verify success
```bash
fly logs -a policyguard-croo
```
Success looks like:
```
[serve] starting resilient PolicyGuard provider (worker, no HTTP server)
[provider] connected and listening
```
The CROO key must appear **only** redacted — the SDK logs the WebSocket URL as
`...key=***`, never the real key. If you ever see a raw `croo_sk_...` in the
logs, stop and report it.

```bash
fly status -a policyguard-croo
```
Confirm one machine, state `started`, in `iad`.

---

## Operating notes

- **Update the running agent:** commit to the branch (after merge), then
  `fly deploy -a policyguard-croo`. Fly sends `SIGTERM`; the supervisor shuts
  down cleanly and the new machine takes over.
- **Rotate the key:** `fly secrets set CROO_SDK_KEY="croo_sk_..." -a policyguard-croo`
  triggers a restart with the new secret. The old value never touches git.
- **Local dev is unchanged:** `npx tsx src/serve.ts` (with a gitignored `.env`)
  runs the same supervisor locally; `Ctrl+C` stops it cleanly.
- **Nothing secret is in git:** `.env` is gitignored and excluded from the image
  by `.dockerignore`; only env var *names* appear in tracked files.
