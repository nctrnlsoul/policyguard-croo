// PolicyGuard provider agent.
//
// This wires the pure policy engine (./policy.js) to the real CROO SDK
// (@croo-network/sdk). It listens for incoming negotiations, accepts them, and
// when an order is paid it maps the buyer's submitted input to a PolicyInput,
// runs evaluate, and delivers the decision as the deliverable.
//
// Importing this module does NOT open a connection. The connect-and-listen
// logic lives in the exported start function and only runs when called.
//
// SDK shape this code is built against (confirmed from the installed package):
//   - AgentClient(config, sdkKey) is the only client. config is
//     { baseURL, wsURL }. The SDK key is the SECOND constructor argument, not a
//     config field.
//   - client.connectWebSocket() returns an EventStream that is already
//     connected. EventStream has .on(eventType, handler), .onAny, .close, .err.
//   - Events carry snake_case fields: e.negotiation_id and e.order_id (both
//     optional on the Event type, so we guard them).
//   - Provider path: on EventType.NegotiationCreated call
//     acceptNegotiation(negotiationId) which returns { negotiation, order }.
//     On EventType.OrderPaid call deliverOrder(orderId, req).
//   - The buyer's submitted input is the negotiation.requirements string (set
//     by the requester at negotiate time). The OrderPaid event only gives an
//     order_id, so we cache requirements by orderId at accept time and fall
//     back to fetching getOrder then getNegotiation if the cache misses (for
//     example after a restart).

import {
  AgentClient,
  EventType,
  DeliverableType,
  APIError,
  type Config,
  type Event,
  type EventStream,
} from "@croo-network/sdk";
import { evaluate, type PolicyInput, type ActionType, type PolicyResult } from "./policy.js";
import { loadProviderConfig, createRedactingLogger } from "./config.js";

// The action types the policy engine understands. Used to validate buyer input.
const VALID_ACTIONS: readonly ActionType[] = ["transfer", "swap", "contract_call"];

/**
 * Build an AgentClient from the provider configuration. Reads env at call time.
 */
function buildClient(): AgentClient {
  const env = loadProviderConfig();
  const config: Config = {
    baseURL: env.apiUrl,
    wsURL: env.wsUrl,
    logger: createRedactingLogger(),
  };
  return new AgentClient(config, env.sdkKey);
}

/**
 * Parse and validate the buyer's submitted requirements string into a
 * PolicyInput. Throws a clear error if the shape is wrong. This keeps a single
 * malformed order from being treated as a valid action.
 */
export function toPolicyInput(requirements: string): PolicyInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requirements);
  } catch {
    throw new Error("Requirements is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Requirements must be a JSON object.");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.action !== "string" || !VALID_ACTIONS.includes(obj.action as ActionType)) {
    throw new Error('Requirements.action must be one of "transfer", "swap", or "contract_call".');
  }
  if (typeof obj.asset !== "string" || obj.asset.length === 0) {
    throw new Error("Requirements.asset must be a non-empty string.");
  }
  if (typeof obj.amount !== "number" || !Number.isFinite(obj.amount)) {
    throw new Error("Requirements.amount must be a finite number.");
  }
  if (typeof obj.recipient !== "string" || obj.recipient.length === 0) {
    throw new Error("Requirements.recipient must be a non-empty string.");
  }

  const input: PolicyInput = {
    action: obj.action as ActionType,
    asset: obj.asset,
    amount: obj.amount,
    recipient: obj.recipient,
  };

  // Pass through an optional context object if present, so the velocity rule and
  // any free-form detail survive the mapping.
  if (typeof obj.context === "object" && obj.context !== null) {
    input.context = obj.context as PolicyInput["context"];
  }

  return input;
}

/**
 * Log an error without leaking secrets. Only message and structured APIError
 * fields are printed, never config or key material.
 */
function logError(scope: string, err: unknown): void {
  if (err instanceof APIError) {
    console.error(`[provider] ${scope}: APIError code=${err.code} reason=${err.reason} message=${err.message}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[provider] ${scope}: ${message}`);
}

/**
 * Start the provider: connect, accept incoming negotiations, and on payment run
 * the policy check and deliver the result. Returns the live EventStream so the
 * caller can close it. This function performs the live work and is intentionally
 * not run on import.
 */
export async function start(): Promise<EventStream> {
  const client = buildClient();

  // Cache of buyer requirements keyed by orderId, populated when we accept a
  // negotiation so we can read the buyer's input again at payment time.
  const requirementsByOrderId = new Map<string, string>();

  const stream = await client.connectWebSocket();

  // A new negotiation arrived. Accept it and remember the buyer's requirements.
  stream.on(EventType.NegotiationCreated, async (e: Event) => {
    try {
      if (!e.negotiation_id) {
        return;
      }
      const result = await client.acceptNegotiation(e.negotiation_id);
      requirementsByOrderId.set(result.order.orderId, result.negotiation.requirements);
      console.log(`[provider] accepted negotiation, order ${result.order.orderId} created`);
    } catch (err) {
      // One bad negotiation must not crash the provider.
      logError("acceptNegotiation", err);
    }
  });

  // An order was paid. Map the buyer input, run the policy check, and deliver.
  stream.on(EventType.OrderPaid, async (e: Event) => {
    const orderId = e.order_id;
    try {
      if (!orderId) {
        return;
      }

      // Prefer the cached requirements. Fall back to fetching them if missing.
      let requirements = requirementsByOrderId.get(orderId);
      if (requirements === undefined) {
        const order = await client.getOrder(orderId);
        const negotiation = await client.getNegotiation(order.negotiationId);
        requirements = negotiation.requirements;
      }

      const input = toPolicyInput(requirements);
      const result: PolicyResult = evaluate(input);

      // Deliver the decision as a Schema deliverable. The JSON carries the full
      // result (decision, matchedRule, reason).
      await client.deliverOrder(orderId, {
        deliverableType: DeliverableType.Schema,
        deliverableSchema: JSON.stringify(result),
      });

      requirementsByOrderId.delete(orderId);
      console.log(`[provider] delivered decision "${result.decision}" for order ${orderId}`);
    } catch (err) {
      // One bad order must not crash the provider.
      logError("deliverOrder", err);
    }
  });

  console.log("[provider] connected and listening");
  return stream;
}
