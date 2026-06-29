// Live runner for the PolicyGuard provider.
//
// Imports the provider's exported start function and calls it. The provider
// connects to CROO using the keys loaded from .env, accepts incoming
// negotiations, and on payment runs the policy check and delivers a decision.
// It only RECEIVES and answers calls; it never pays anyone, so this process
// moves no funds on its own.
//
// The open WebSocket keeps the event loop alive, so this process stays running
// and listening until interrupted. No secret value is ever printed.
import { start } from "./dist/provider.js";

console.log("[runner] starting PolicyGuard provider (receive-only, no payments)...");

start()
  .then((stream) => {
    console.log("[runner] provider start() resolved: WebSocket open, listening for events");
    console.log("[runner] waiting for negotiations and orders. Press Ctrl+C to stop.");

    // Surface any later stream-level error without crashing.
    const err = stream.err();
    if (err) {
      console.error("[runner] stream reported error:", err.message);
    }

    // Clean shutdown on Ctrl+C.
    process.on("SIGINT", () => {
      console.log("[runner] SIGINT received, closing WebSocket and exiting");
      stream.close();
      process.exit(0);
    });
  })
  .catch((e) => {
    console.error("[runner] provider failed to start:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
