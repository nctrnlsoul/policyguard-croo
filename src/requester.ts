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
import { loadRequesterConfig } from "./config.js";

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
 * Start the requester: negotiate an order for the sample action, pay when the
 * order is created, and print the decision when the order completes. This
 * performs the live work and is intentionally not run on import.
 */
export async function start(req: SampleRequest): Promise<void> {
  const env = loadRequesterConfig();
  const config: Config = {
    baseURL: env.apiUrl,
    wsURL: env.wsUrl,
  };
  const client = new AgentClient(config, env.requesterSdkKey);

  const stream = await client.connectWebSocket();

  // Pay as soon as the order is created on-chain.
  stream.on(EventType.OrderCreated, async (e: Event) => {
    try {
      if (!e.order_id) {
        return;
      }
      const result = await client.payOrder(e.order_id);
      console.log(`[requester] payment submitted, tx ${result.txHash}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[requester] payOrder: ${message}`);
    }
  });

  // Read and print the decision once the order completes.
  stream.on(EventType.OrderCompleted, async (e: Event) => {
    try {
      if (!e.order_id) {
        return;
      }
      const delivery = await client.getDelivery(e.order_id);
      const payload = delivery.deliverableSchema || delivery.deliverableText;
      console.log(`[requester] PolicyGuard decision payload: ${payload}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[requester] getDelivery: ${message}`);
    } finally {
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
  console.log(`[requester] negotiation started: ${negotiation.negotiationId}`);
}
