// PolicyGuard test requester agent.
//
// A small client that calls the PolicyGuard service with a sample action and
// prints the returned decision. It is for local testing of the wiring only.
//
// Importing this module does NOT open a connection or send anything. The live
// logic lives in the exported start function and only runs when called.
//
// SDK shape this code is built against (confirmed from the installed package):
//   - AgentClient(config, sdkKey), config is { baseURL, wsURL }.
//   - client.negotiateOrder({ serviceId, requirements }) starts a negotiation.
//   - On EventType.OrderCreated the requester calls payOrder(orderId).
//   - On EventType.OrderCompleted the requester calls getDelivery(orderId) and
//     reads the deliverable. The provider delivers a Schema deliverable, so the
//     payload is on delivery.deliverableSchema (deliverableText is the fallback).
//
// Note on the target service id: config.ts intentionally reads only the four
// project variables (CROO_API_URL, CROO_WS_URL, CROO_SDK_KEY,
// CROO_REQUESTER_SDK_KEY). The service to call is therefore passed in as a
// parameter to start rather than read from a fifth environment variable. This is
// an adaptation flagged in the report.

import {
  AgentClient,
  EventType,
  type Config,
  type Event,
} from "@croo-network/sdk";
import { loadRequesterConfig, createRedactingLogger } from "./config.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Declared locally because the requester only needs to describe a sample action
// to send over the wire. It does not run the engine. This string union mirrors
// the engine's ActionType in src/policy.ts and must stay in sync with it.
type SampleActionType = "transfer" | "swap" | "contract_call";

/**
 * The sample action the requester asks PolicyGuard to check, plus the target
 * service id to negotiate with.
 */
export interface SampleRequest {
  /** The PolicyGuard service id to negotiate with. */
  serviceId: string;
  action: SampleActionType;
  asset: string;
  amount: number;
  recipient: string;
}

/**
 * Format a USDC base-unit amount (6 decimals) for display. Best-effort only:
 * returns the raw string unchanged if it is not a clean non-negative integer.
 * Used purely to make the quoted service fee readable; carries no secret.
 */
function formatUsdc(base: string): string {
  if (!/^\d+$/.test(base)) {
    return base;
  }
  const padded = base.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const frac = padded.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Start the requester: negotiate an order for the sample action, pay the service
 * fee when the order is created, and print the delivered decision when the order
 * completes. Each step is printed with a clear label. No secret value is ever
 * printed. This performs the live work and is intentionally not run on import.
 *
 * It drives exactly one order: a single negotiateOrder, and payOrder is guarded
 * so the fee is paid at most once. When the order completes, the stream is
 * closed so the process can exit.
 */
export async function start(req: SampleRequest): Promise<void> {
  const env = loadRequesterConfig();
  const config: Config = {
    baseURL: env.apiUrl,
    wsURL: env.wsUrl,
    logger: createRedactingLogger(),
  };
  const client = new AgentClient(config, env.requesterSdkKey);

  const stream = await client.connectWebSocket();

  // Pay the service fee once the order is created on-chain. Guarded so a repeat
  // OrderCreated event can never trigger a second payment.
  let hasPaid = false;
  stream.on(EventType.OrderCreated, async (e: Event) => {
    try {
      if (!e.order_id) {
        return;
      }

      // Read the created order to surface the quoted service fee (Order.price,
      // in paymentToken base units — USDC has 6 decimals).
      const order = await client.getOrder(e.order_id);
      console.log(`[requester] ORDER CREATED: ${order.orderId}`);
      console.log(
        `[requester]   quoted price (service fee): ${order.price} base units (~${formatUsdc(order.price)} USDC)`,
      );

      if (hasPaid) {
        return;
      }
      hasPaid = true;

      console.log(`[requester] PAYING service fee...`);
      const result = await client.payOrder(order.orderId);
      console.log(`[requester] PAID: tx ${result.txHash}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[requester] payOrder: ${message}`);
    }
  });

  // Read and print the delivered decision once the order completes.
  stream.on(EventType.OrderCompleted, async (e: Event) => {
    try {
      if (!e.order_id) {
        return;
      }
      const delivery = await client.getDelivery(e.order_id);
      const payload = delivery.deliverableSchema || delivery.deliverableText;

      console.log(`[requester] DELIVERY RECEIVED:`);
      let parsed: { decision?: unknown; matchedRule?: unknown; reason?: unknown } | undefined;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = undefined;
      }
      if (parsed && typeof parsed === "object") {
        console.log(`[requester]   decision:    ${parsed.decision}`);
        console.log(`[requester]   matchedRule: ${parsed.matchedRule}`);
        console.log(`[requester]   reason:      ${parsed.reason}`);
      } else {
        console.log(`[requester]   raw payload: ${payload}`);
      }

      console.log(`[requester] ORDER COMPLETED: ${e.order_id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[requester] getDelivery: ${message}`);
    } finally {
      // The single order is done; close the stream so the process can exit.
      stream.close();
    }
  });

  // Build the requirements payload the provider will map to a PolicyInput.
  const requirements = JSON.stringify({
    action: req.action,
    asset: req.asset,
    amount: req.amount,
    recipient: req.recipient,
  });

  const negotiation = await client.negotiateOrder({
    serviceId: req.serviceId,
    requirements,
  });
  console.log(`[requester] NEGOTIATION CREATED: ${negotiation.negotiationId}`);
  console.log(
    `[requester]   (the service fee is quoted on the order; printed at "ORDER CREATED")`,
  );
}

// ---------------------------------------------------------------------------
// Runner entry point.
//
// When this file is executed directly (for example `npx tsx src/requester.ts`),
// drive exactly one real order against a running PolicyGuard provider, then exit
// when it completes (start closes the WebSocket on OrderCompleted). Importing
// the module instead does not reach this block, so importing stays side-effect
// free.
//
// The target service id is supplied at run time (it is not a project env var):
//   npx tsx src/requester.ts <serviceId>
// or set POLICYGUARD_SERVICE_ID in the environment.

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
  const PLACEHOLDER = "PASTE_SERVICE_ID_HERE";
  const serviceId = process.argv[2] || process.env.POLICYGUARD_SERVICE_ID || PLACEHOLDER;

  // Refuse to negotiate with the unfilled placeholder. Nothing is sent and no
  // fee is paid in this case.
  if (!serviceId || serviceId === PLACEHOLDER) {
    console.error("[requester] No real PolicyGuard service id was provided.");
    console.error("[requester] Pass it as an argument:  npx tsx src/requester.ts <serviceId>");
    console.error("[requester] or set POLICYGUARD_SERVICE_ID in the environment.");
    console.error("[requester] Refusing to negotiate with the placeholder. Nothing sent; no fee paid.");
    process.exit(2);
  }

  const req: SampleRequest = {
    serviceId,
    action: "contract_call",
    asset: "USDC",
    amount: 50,
    recipient: "0x000000000000000000000000000000000000dEaD",
  };

  console.log("[requester] driving a single PolicyGuard order (pays the ~$0.10 service fee once).");
  console.log(`[requester] target service: ${serviceId}`);
  console.log(`[requester] sample action: contract_call 50 USDC -> ${req.recipient} (denied by default policy)`);

  // Safety watchdog: if the order never completes, exit instead of hanging
  // forever. Unref'd so it does not by itself keep the process alive once the
  // requester closes its WebSocket after completion. Set generously: on-chain
  // settlement on Base (pay -> deliver -> clear) can take a few minutes.
  const watchdog = setTimeout(() => {
    console.error("[requester] timed out after 300s waiting for the order to complete. Exiting.");
    process.exit(1);
  }, 300_000);
  watchdog.unref();

  // Clean exit on Ctrl+C.
  process.on("SIGINT", () => {
    console.log("[requester] SIGINT received, exiting");
    process.exit(0);
  });

  await start(req);
  console.log("[requester] negotiation sent; waiting for order to be created, paid, and delivered...");
}

if (isRunDirectly()) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[requester] requester failed: ${message}`);
    process.exit(1);
  });
}
