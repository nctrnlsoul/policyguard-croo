// PolicyGuard policy engine.
//
// This module is pure: no network, no file I/O, no environment reads, and no
// side effects. It takes a proposed on-chain action plus a policy config and
// returns an allow or deny decision with a human-readable reason.
//
// The engine is composable. Each rule is a small named function that takes the
// action and the resolved config and returns either null (the rule passes) or a
// RuleDenial (the rule wants to deny, with its id and reason). Rules run in a
// fixed order and the first denial wins. If no rule denies, the action is
// allowed.

/**
 * The kind of on-chain action an agent wants to perform.
 */
export type ActionType = "transfer" | "swap" | "contract_call";

/**
 * Free-form context an agent may attach to an action. The velocity rule reads
 * recentActionCount and windowSeconds from here. Any other keys are ignored by
 * the engine but preserved for callers that want to pass extra detail.
 */
export interface ActionContext {
  /** How many actions this agent has taken in the recent window. */
  recentActionCount?: number;
  /** The size of the window the recentActionCount was measured over, in seconds. */
  windowSeconds?: number;
  /** Any additional caller-supplied detail. */
  [key: string]: unknown;
}

/**
 * The proposed action to be checked against policy.
 */
export interface PolicyInput {
  action: ActionType;
  /** The asset symbol, for example "USDC". */
  asset: string;
  /** The amount of the asset involved in the action. */
  amount: number;
  /** The recipient address. */
  recipient: string;
  /** Optional extra detail, including velocity fields. */
  context?: ActionContext;
}

/**
 * The decision returned by the engine.
 */
export interface PolicyResult {
  decision: "allow" | "deny";
  /** The id of the rule that produced a deny, or null when allowed. */
  matchedRule: string | null;
  /** A short, clear, human-readable explanation. */
  reason: string;
}

/**
 * The policy configuration. Callers may pass a partial version of this and the
 * engine merges it over DEFAULT_POLICY_CONFIG.
 */
export interface PolicyConfig {
  /** Maximum allowed amount for a single action. */
  maxAmount: number;
  /** Recipients that are always denied. */
  deniedRecipients: string[];
  /**
   * If non-empty, only these recipients are allowed. An empty list disables the
   * allow-list gate.
   */
  allowedRecipients: string[];
  /** Action types that are always denied. */
  deniedActions: ActionType[];
  /**
   * If true, contract_call is permitted even when the recipient is not on the
   * allow-list. If false, contract_call is denied unless the recipient is on a
   * non-empty allow-list.
   */
  allowContractCall: boolean;
  /** Maximum number of actions permitted within the velocity window. */
  maxActionsPerWindow: number;
  /** The velocity window size, in seconds. */
  windowSeconds: number;
}

/**
 * A rule's denial result: the rule id plus a reason. A rule returns null when
 * it does not want to deny.
 */
export interface RuleDenial {
  matchedRule: string;
  reason: string;
}

/**
 * A policy rule. Returns null to pass, or a RuleDenial to deny.
 */
export type PolicyRule = (input: PolicyInput, config: PolicyConfig) => RuleDenial | null;

/**
 * A sensible default policy. Callers override any subset of these fields.
 *
 * Note: the default allow-list and deny-list are empty, so by default any
 * recipient is acceptable. contract_call is denied by default (allowContractCall
 * is false), matching a conservative guardrail posture.
 */
export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  maxAmount: 1000,
  deniedRecipients: [],
  allowedRecipients: [],
  deniedActions: [],
  allowContractCall: false,
  maxActionsPerWindow: 10,
  windowSeconds: 60,
};

/**
 * Normalize an address for comparison. On-chain addresses are commonly compared
 * case-insensitively, so we lowercase and trim. This keeps the allow-list and
 * deny-list robust against casing differences.
 */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * spendCap: deny if amount exceeds config.maxAmount. An amount exactly at the
 * cap is allowed.
 */
export const spendCap: PolicyRule = (input, config) => {
  if (input.amount > config.maxAmount) {
    return {
      matchedRule: "spendCap",
      reason: `Amount ${input.amount} ${input.asset} exceeds the maximum allowed amount of ${config.maxAmount}.`,
    };
  }
  return null;
};

/**
 * denyList: deny if recipient is in config.deniedRecipients.
 */
export const denyList: PolicyRule = (input, config) => {
  const recipient = normalizeAddress(input.recipient);
  const denied = config.deniedRecipients.some((r) => normalizeAddress(r) === recipient);
  if (denied) {
    return {
      matchedRule: "denyList",
      reason: `Recipient ${input.recipient} is on the deny-list.`,
    };
  }
  return null;
};

/**
 * allowList: if config.allowedRecipients is non-empty, deny any recipient not on
 * it. If the allow-list is empty, this rule does not apply.
 */
export const allowList: PolicyRule = (input, config) => {
  if (config.allowedRecipients.length === 0) {
    return null;
  }
  const recipient = normalizeAddress(input.recipient);
  const onList = config.allowedRecipients.some((r) => normalizeAddress(r) === recipient);
  if (!onList) {
    return {
      matchedRule: "allowList",
      reason: `Recipient ${input.recipient} is not on the allow-list.`,
    };
  }
  return null;
};

/**
 * actionPolicy: deny action types in config.deniedActions. By default this also
 * denies contract_call unless the recipient is on a non-empty allow-list or
 * contract_call is explicitly permitted via config.allowContractCall.
 */
export const actionPolicy: PolicyRule = (input, config) => {
  if (config.deniedActions.includes(input.action)) {
    return {
      matchedRule: "actionPolicy",
      reason: `Action type "${input.action}" is denied by policy.`,
    };
  }

  if (input.action === "contract_call") {
    const recipient = normalizeAddress(input.recipient);
    const onAllowList =
      config.allowedRecipients.length > 0 &&
      config.allowedRecipients.some((r) => normalizeAddress(r) === recipient);
    const permitted = config.allowContractCall || onAllowList;
    if (!permitted) {
      return {
        matchedRule: "actionPolicy",
        reason:
          "Action type \"contract_call\" is denied by default. Permit it via allowContractCall or place the recipient on the allow-list.",
      };
    }
  }

  return null;
};

/**
 * velocity: deny if context.recentActionCount exceeds config.maxActionsPerWindow.
 * The window size used in the explanation is context.windowSeconds when provided,
 * otherwise config.windowSeconds. If recentActionCount is not provided, the rule
 * does not apply.
 */
export const velocity: PolicyRule = (input, config) => {
  const count = input.context?.recentActionCount;
  if (typeof count !== "number") {
    return null;
  }
  if (count > config.maxActionsPerWindow) {
    const window = input.context?.windowSeconds ?? config.windowSeconds;
    return {
      matchedRule: "velocity",
      reason: `Recent action count ${count} exceeds the limit of ${config.maxActionsPerWindow} within ${window} seconds.`,
    };
  }
  return null;
};

/**
 * The ordered rule set. Rules run in this order and the first denial wins.
 */
export const POLICY_RULES: PolicyRule[] = [spendCap, denyList, allowList, actionPolicy, velocity];

/**
 * Evaluate a proposed action against policy.
 *
 * @param input The proposed action.
 * @param config An optional partial config merged over DEFAULT_POLICY_CONFIG.
 * @returns An allow or deny decision with the matched rule and a reason.
 */
export function evaluate(input: PolicyInput, config: Partial<PolicyConfig> = {}): PolicyResult {
  const resolved: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, ...config };

  for (const rule of POLICY_RULES) {
    const denial = rule(input, resolved);
    if (denial) {
      return {
        decision: "deny",
        matchedRule: denial.matchedRule,
        reason: denial.reason,
      };
    }
  }

  return {
    decision: "allow",
    matchedRule: null,
    reason: "Action satisfies all policy rules.",
  };
}
