// Live runner for the PolicyGuard requester.
//
// Drives ONE real order against a running PolicyGuard provider. It imports the
// requester's exported start function and calls it exactly once with a sample
// action. The requester negotiates the order, pays the small service fee from
// the requester wallet, and prints each step (negotiation created, order
// created with the quoted price, paying, paid, delivery received with the full
// decision, order completed). Keys are loaded from .env by the requester's
// config loader; no secret value is ever printed here.
//
// This pays the service fee (~$0.10) once. It does not loop and never sends a
// second order. When the order completes the requester closes its WebSocket and
// this process exits on its own.
//
// The target service id is supplied at run time (it is not a project env var):
//   node run-requester.mjs <serviceId>
// or set POLICYGUARD_SERVICE_ID in the environment.
import { start } from "./dist/requester.js";

const PLACEHOLDER = "PASTE_SERVICE_ID_HERE";
const serviceId = process.argv[2] || process.env.POLICYGUARD_SERVICE_ID || PLACEHOLDER;

const req = {
  serviceId,
  action: "transfer",
  asset: "USDC",
  amount: 50,
  recipient: "0x000000000000000000000000000000000000dEaD",
};

// Refuse to negotiate with the unfilled placeholder. Nothing is sent and no fee
// is paid in this case.
if (!serviceId || serviceId === PLACEHOLDER) {
  console.error("[runner] No real PolicyGuard service id was provided.");
  console.error("[runner] Pass it as an argument:  node run-requester.mjs <serviceId>");
  console.error("[runner] or set POLICYGUARD_SERVICE_ID in the environment.");
  console.error("[runner] Refusing to negotiate with the placeholder. Nothing sent; no fee paid.");
  process.exit(2);
}

console.log("[runner] driving a single PolicyGuard order (pays the ~$0.10 service fee once).");
console.log(`[runner] target service: ${serviceId}`);
console.log(`[runner] sample action: transfer 50 USDC -> ${req.recipient}`);

// Safety watchdog: if the order never completes, exit instead of hanging
// forever. Unref'd so it does not by itself keep the process alive once the
// requester has closed its WebSocket after completion. Set generously: on-chain
// settlement on Base (pay -> deliver -> clear) can take a few minutes.
const watchdog = setTimeout(() => {
  console.error("[runner] timed out after 300s waiting for the order to complete. Exiting.");
  process.exit(1);
}, 300_000);
watchdog.unref();

start(req)
  .then(() => {
    console.log("[runner] negotiation sent; waiting for order to be created, paid, and delivered...");
  })
  .catch((e) => {
    clearTimeout(watchdog);
    console.error("[runner] requester failed:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });

// Clean exit on Ctrl+C.
process.on("SIGINT", () => {
  console.log("[runner] SIGINT received, exiting");
  process.exit(0);
});
