# PolicyGuard

A callable guardrail agent for the CROO Agent Hackathon that checks a proposed on-chain action against policy and returns **allow** or **deny** with a reason.

Status: working — validated end-to-end with a real settled order on Base (see [Proven on Base](#proven-on-base)).

## What PolicyGuard is

PolicyGuard is a guardrail service that other agents can call before they act on-chain. A caller describes a proposed action (an asset transfer, a swap, or a contract call); PolicyGuard runs it through a policy engine and returns a structured decision — `allow` or `deny`, the rule that matched, and a plain-language reason.

It runs as a service on the [CROO](https://croo.network) agent marketplace (an AI-agent marketplace on Base). Each call is a CROO order: the requester negotiates an order, pays a small **USDC service fee** (the price set on the service, ~0.10 USDC), and the provider delivers the decision as the order deliverable. The on-chain order settles the fee; the policy decision itself is the delivered payload.

The policy engine (`src/policy.ts`) is **pure** — no network, no file I/O, no environment reads. That keeps the decision logic deterministic and unit-testable on its own, separate from the SDK wiring.

## How a call flows

1. **Requester** negotiates an order for the PolicyGuard service, attaching the proposed action as the order requirements.
2. **Provider** accepts the negotiation; CROO creates the order on-chain.
3. **Requester** pays the order (the USDC service fee).
4. **Provider** sees the order paid, maps the requirements to a policy input, runs the engine, and delivers the decision.
5. **Requester** reads the delivered decision when the order completes.

## Policy rules

The engine evaluates an action against an ordered set of rules; **the first rule that denies wins**, otherwise the action is allowed. The rules (in order) are:

| Rule | What it does |
| --- | --- |
| `spendCap` | Denies when `amount` exceeds the configured `maxAmount`. An amount exactly at the cap is allowed. |
| `denyList` | Denies when the recipient is on the configured deny-list (addresses compared case-insensitively). |
| `allowList` | When a non-empty allow-list is configured, denies any recipient not on it. An empty allow-list disables this gate. |
| `actionPolicy` | Denies any action type in the configured deny-list, and denies `contract_call` **by default** unless `allowContractCall` is set or the recipient is on a non-empty allow-list. |
| `velocity` | When the caller supplies a recent-action count, denies when it exceeds `maxActionsPerWindow` within the velocity window. |

An allowed action returns `{ decision: "allow", matchedRule: null, reason: "Action satisfies all policy rules." }`.

### Default policy

The deployed provider evaluates with the engine defaults (`DEFAULT_POLICY_CONFIG`):

- `maxAmount`: `1000`
- `deniedRecipients`: empty (no recipient denied by default)
- `allowedRecipients`: empty (allow-list gate disabled)
- `deniedActions`: empty
- `allowContractCall`: `false` (so `contract_call` is denied by default)
- `maxActionsPerWindow`: `10`, `windowSeconds`: `60`

Callers of `evaluate()` can override any subset of these; the engine merges a partial config over the defaults.

## Setup and running

### Requirements

- Node.js **18+**
- A CROO account with a provider agent (which exposes the PolicyGuard service) and a requester agent. Account setup, service registration, and SDK-Key issuance happen in the CROO Dashboard, outside this repo.

### Install

```bash
npm install
```

### Configure environment

Configuration is read from environment variables **by name only** — no values are ever hardcoded or printed. Copy `.env.example` to `.env` and fill in your own values:

| Variable | Purpose |
| --- | --- |
| `CROO_API_URL` | CROO REST API base URL |
| `CROO_WS_URL` | CROO WebSocket URL |
| `CROO_SDK_KEY` | SDK key for the **provider** agent |
| `CROO_REQUESTER_SDK_KEY` | SDK key for the **requester** agent |

`.env` is gitignored. Never commit real key values. The SDK key is sensitive — see [Integration notes](#integration-notes) on how the code keeps it out of logs.

### Build

```bash
npm run build
```

This compiles `src/` to `dist/` (the runners import the compiled output).

### Run the provider

The provider connects, accepts incoming negotiations, and on payment runs the policy check and delivers the decision. It only receives and answers calls — it never pays anyone.

```bash
node run-provider.mjs
```

It stays running and listening until interrupted (Ctrl+C).

### Run the requester

The requester drives a single order: it negotiates, pays the service fee once, and prints the delivered decision, then exits. Pass the target PolicyGuard service id as an argument (or set `POLICYGUARD_SERVICE_ID`):

```bash
node run-requester.mjs <serviceId>
```

It sends exactly one order — it does not loop. The sample action it submits is a transfer of 50 USDC to a recipient address; with the default policy that returns `allow`.

## CROO SDK methods used

Built against `@croo-network/sdk`. `AgentClient(config, sdkKey)` is the only client; the SDK key is the **second** constructor argument, not a config field.

**Provider** (`src/provider.ts`):

- `new AgentClient(config, sdkKey)` — build the client
- `connectWebSocket()` — open the event stream
- `acceptNegotiation(negotiationId)` — accept an incoming negotiation (returns `{ negotiation, order }`); CROO then creates the order on-chain
- `deliverOrder(orderId, req)` — deliver the policy decision once the order is paid
- supporting reads: `getOrder` / `getNegotiation` (fallback to recover buyer requirements if the in-memory cache misses)

**Requester** (`src/requester.ts`):

- `new AgentClient(config, requesterSdkKey)` — build the client
- `connectWebSocket()` — open the event stream
- `negotiateOrder({ serviceId, requirements })` — start a negotiation with the proposed action
- `payOrder(orderId)` — pay the order (the USDC service fee) when it is created
- `getDelivery(orderId)` — read the delivered decision when the order completes
- supporting read: `getOrder` (to surface the quoted price)

Events are driven through `EventType` (`NegotiationCreated`, `OrderCreated`, `OrderPaid`, `OrderCompleted`); the provider reacts to `OrderPaid`, the requester to `OrderCreated` and `OrderCompleted`.

## Integration notes

- **Schema deliverable.** The provider delivers the decision as a `DeliverableType.Schema` deliverable, with the full `PolicyResult` (`decision`, `matchedRule`, `reason`) JSON-encoded in `deliverableSchema`. The requester reads `delivery.deliverableSchema` (falling back to `deliverableText`).
- **Redacting logger for SDK-key safety.** The SDK's default logger prints the WebSocket URL, which embeds the SDK key as `?key=croo_sk_...`. Both clients are constructed with a custom `logger` (`createRedactingLogger()` in `src/config.ts`) that scrubs `croo_sk_...` tokens and `key=...` query parameters from every log line, so key material never reaches stdout.
- **Requirements cached by orderId.** The buyer's submitted input lives on `negotiation.requirements`, but the `OrderPaid` event only carries an `order_id`. The provider caches the requirements keyed by `orderId` at accept time, and falls back to fetching `getOrder` then `getNegotiation` if the cache misses (for example after a restart). This keeps a single malformed or out-of-band order from being mishandled.

## Proven on Base

PolicyGuard has been validated end-to-end against the live CROO marketplace on Base, not just in unit tests. A real order was negotiated against the running provider, the ~0.10 USDC service fee was paid from the requester wallet, and the provider delivered an `allow` decision for the sample transfer. The order reached `completed` with the on-chain pay, deliver, and clear transactions all settled, and the delivery was accepted — confirming the full negotiate → pay → policy-check → deliver path works on-chain.

## Testing

The pure policy engine is covered by unit tests (`src/policy.test.ts`):

```bash
npm test          # run once (vitest)
npm run test:watch
```

## Project layout

| Path | What it is |
| --- | --- |
| `src/policy.ts` | Pure policy engine (rules + `evaluate`) |
| `src/policy.test.ts` | Unit tests for the engine |
| `src/provider.ts` | Provider agent: accept negotiations, run policy, deliver |
| `src/requester.ts` | Requester agent: negotiate, pay, read decision |
| `src/config.ts` | Env-var loading (by name) and the redacting logger |
| `run-provider.mjs` | Runner that starts the provider (receive-only) |
| `run-requester.mjs` | Runner that drives a single requester order |

## License

[MIT](LICENSE) © 2026 Brian Araujo
