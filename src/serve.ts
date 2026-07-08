// Resilient always-on entrypoint for the PolicyGuard provider.
//
// This is the process that runs 24/7 in production (on Fly.io). It imports the
// provider's exported start() unchanged and wraps it in a supervisor that keeps
// the agent online and hireable without any human babysitting a terminal.
//
// Importing this module does NOT connect or do any work: all live logic sits
// behind the isRunDirectly() guard at the bottom, matching provider.ts and
// requester.ts. The redacting logger is preserved automatically — it lives
// inside start()'s buildClient(), which this file does not touch.
//
// -------------------------------------------------------------------------
// What the supervisor adds on top of the SDK
// -------------------------------------------------------------------------
// The CROO SDK's EventStream already self-heals TRANSIENT drops: on socket
// close, socket error, or a pong timeout it reconnects on its own in an
// indefinite loop with exponential backoff capped at 30s. So a normal network
// blip does not need our help.
//
// The SDK does NOT cover two cases, and those are this supervisor's job:
//   1. Boot-time connect failure — the very first connectWebSocket() REJECTS if
//      the initial dial fails. Left alone, start() throws and the process would
//      crash-exit. We retry with backoff instead, indefinitely.
//   2. Terminal stream error — on a WS 1008 policy violation (duplicate
//      SDK-Key) the SDK stops reconnecting and records the error on
//      stream.err(). There is no public close/error CALLBACK (the only public
//      signals are stream.err() and stream.close()), so we poll err() on an
//      interval; when it goes non-null we tear the stream down and start over.
//
// The supervisor also keeps the process alive as a pure worker (the poll timer
// plus the open WebSocket hold the event loop open — no HTTP server) and shuts
// down cleanly on SIGINT/SIGTERM for local dev and for Fly's deploy signals.

import { start } from "./provider.js";
import type { EventStream } from "@croo-network/sdk";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Backoff schedule for boot-retry and post-terminal-error restarts. Matches the
// SDK's own cap (30s) so our restart cadence never looks slower than its
// internal reconnect. A little jitter avoids a thundering-herd retry pattern.
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

// How often to poll stream.err() for the terminal-error case above. The stream
// is otherwise healthy between polls; this only catches the states the SDK
// abandons, so a coarse interval is fine.
const HEALTH_POLL_MS = 15_000;

/** Backoff for the Nth consecutive failure (0-based), capped and jittered. */
function backoffDelay(attempt: number): number {
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Full jitter: a random point in [0, capped]. Keeps retries from synchronizing.
  return Math.floor(Math.random() * capped);
}

/** Sleep that resolves early if the shutdown signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(resolveSleep, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveSleep();
      },
      { once: true },
    );
  });
}

/**
 * Run one connected session to completion: connect via start(), then hold it
 * open until either a terminal stream error surfaces or shutdown is requested.
 * Returns when the session ends so the supervisor can decide whether to restart.
 *
 * Throws if start() itself fails (the boot-time / reconnect-attempt failure the
 * supervisor catches and backs off on).
 */
async function runSession(signal: AbortSignal): Promise<void> {
  const stream: EventStream = await start();

  // Surface any error already present at connect time (e.g. an immediate
  // duplicate-key rejection reported on the stream rather than thrown).
  const bootErr = stream.err();
  if (bootErr) {
    console.error(`[serve] stream reported error at connect: ${bootErr.message}`);
    stream.close();
    return;
  }

  try {
    // Hold the session open. Every HEALTH_POLL_MS, check the one failure mode
    // the SDK does not recover from (it stops reconnecting and sets err()).
    // Everything else is self-healed inside the SDK's reconnect loop, so we do
    // nothing and let it work.
    for (;;) {
      await sleep(HEALTH_POLL_MS, signal);
      if (signal.aborted) {
        return;
      }
      const err = stream.err();
      if (err) {
        console.error(`[serve] stream entered a terminal error, restarting: ${err.message}`);
        return;
      }
    }
  } finally {
    // Always release the socket before we loop to a fresh start() or exit, so a
    // restart never leaves a duplicate connection (which would itself trigger a
    // 1008 policy violation on the new one).
    stream.close();
  }
}

/**
 * Supervise the provider forever: (re)connect, hold the session, and on any
 * failure log it, back off with a cap of ~30s, and reconnect — indefinitely.
 * Never crash-exits; the only way out is a shutdown signal.
 */
async function supervise(signal: AbortSignal): Promise<void> {
  let failures = 0;

  while (!signal.aborted) {
    try {
      await runSession(signal);
      // A clean session end (terminal error handled, or shutdown) resets the
      // backoff so the next reconnect starts fast rather than pre-penalized.
      failures = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[serve] connect/session failed: ${message}`);
      failures += 1;
    }

    if (signal.aborted) {
      return;
    }

    const delay = backoffDelay(failures);
    console.log(`[serve] reconnecting in ${Math.round(delay / 1000)}s (attempt ${failures + 1})`);
    await sleep(delay, signal);
  }
}

// ---------------------------------------------------------------------------
// Runner entry point.
//
// When this file is executed directly (production: `node dist/serve.js`; local:
// `npx tsx src/serve.ts`), start the supervisor and keep the worker alive.
// Importing the module instead does not reach this block, so importing stays
// side-effect free.

/**
 * True when this module is the process entry point rather than an import. Path
 * resolution handles the difference between the file: URL and argv[1] on every
 * platform.
 */
function isRunDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return resolve(fileURLToPath(import.meta.url)) === resolve(entry);
}

async function main(): Promise<void> {
  console.log("[serve] starting resilient PolicyGuard provider (worker, no HTTP server)");

  // One controller drives clean shutdown: SIGINT (Ctrl+C, local dev) and
  // SIGTERM (Fly deploy/stop) both abort it, which unblocks any in-flight
  // backoff/poll sleep and lets supervise() return so the process exits 0.
  const controller = new AbortController();
  let shuttingDown = false;
  const shutdown = (name: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[serve] ${name} received, shutting down`);
    controller.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await supervise(controller.signal);
  console.log("[serve] supervisor stopped, exiting");
  process.exit(0);
}

if (isRunDirectly()) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[serve] fatal: ${message}`);
    process.exit(1);
  });
}
