import { describe, it, expect } from "vitest";
import {
  evaluate,
  spendCap,
  denyList,
  velocity,
  DEFAULT_POLICY_CONFIG,
  type PolicyInput,
  type PolicyConfig,
} from "./policy.js";

// A clean baseline action used across tests. Individual tests override fields as
// needed. It is a plain "transfer" so it does not trip the contract_call gate.
function baseAction(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    action: "transfer",
    asset: "USDC",
    amount: 100,
    recipient: "0xRECIPIENT",
    ...overrides,
  };
}

describe("evaluate: spendCap", () => {
  it("allows an amount under the cap", () => {
    const result = evaluate(baseAction({ amount: 500 }), { maxAmount: 1000 });
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toBe("Action satisfies all policy rules.");
  });

  it("allows an amount exactly at the cap", () => {
    const result = evaluate(baseAction({ amount: 1000 }), { maxAmount: 1000 });
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toBe("Action satisfies all policy rules.");
  });

  it("denies an amount over the cap", () => {
    const result = evaluate(baseAction({ amount: 1001 }), { maxAmount: 1000 });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("spendCap");
    expect(result.reason).toBe(
      "Amount 1001 USDC exceeds the maximum allowed amount of 1000.",
    );
  });
});

describe("evaluate: denyList", () => {
  it("denies a recipient on the deny-list", () => {
    const result = evaluate(baseAction({ recipient: "0xBAD" }), {
      deniedRecipients: ["0xBAD"],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("denyList");
    expect(result.reason).toBe("Recipient 0xBAD is on the deny-list.");
  });

  it("denies regardless of address casing", () => {
    const result = evaluate(baseAction({ recipient: "0xabc" }), {
      deniedRecipients: ["0xABC"],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("denyList");
    expect(result.reason).toBe("Recipient 0xabc is on the deny-list.");
  });
});

describe("evaluate: allowList", () => {
  it("denies an off-list recipient when the allow-list is non-empty", () => {
    const result = evaluate(baseAction({ recipient: "0xSTRANGER" }), {
      allowedRecipients: ["0xFRIEND"],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("allowList");
    expect(result.reason).toBe("Recipient 0xSTRANGER is not on the allow-list.");
  });

  it("allows an on-list recipient when the allow-list is non-empty", () => {
    const result = evaluate(baseAction({ recipient: "0xFRIEND" }), {
      allowedRecipients: ["0xFRIEND"],
    });
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toBe("Action satisfies all policy rules.");
  });
});

describe("evaluate: actionPolicy", () => {
  it("denies a contract_call by default", () => {
    const result = evaluate(baseAction({ action: "contract_call" }));
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("actionPolicy");
    expect(result.reason).toBe(
      'Action type "contract_call" is denied by default. Permit it via allowContractCall or place the recipient on the allow-list.',
    );
  });

  it("allows a contract_call when explicitly permitted", () => {
    const result = evaluate(baseAction({ action: "contract_call" }), {
      allowContractCall: true,
    });
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toBe("Action satisfies all policy rules.");
  });

  it("allows a contract_call when the recipient is on the allow-list", () => {
    const result = evaluate(
      baseAction({ action: "contract_call", recipient: "0xFRIEND" }),
      { allowedRecipients: ["0xFRIEND"] },
    );
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toBe("Action satisfies all policy rules.");
  });

  it("denies an action type listed in deniedActions", () => {
    const result = evaluate(baseAction({ action: "swap" }), {
      deniedActions: ["swap"],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("actionPolicy");
    expect(result.reason).toBe('Action type "swap" is denied by policy.');
  });
});

describe("evaluate: velocity", () => {
  it("denies when recentActionCount exceeds the limit", () => {
    const result = evaluate(
      baseAction({ context: { recentActionCount: 11, windowSeconds: 60 } }),
      { maxActionsPerWindow: 10, windowSeconds: 60 },
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("velocity");
    expect(result.reason).toBe(
      "Recent action count 11 exceeds the limit of 10 within 60 seconds.",
    );
  });

  it("allows when recentActionCount is at the limit", () => {
    const result = evaluate(
      baseAction({ context: { recentActionCount: 10 } }),
      { maxActionsPerWindow: 10 },
    );
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toBe("Action satisfies all policy rules.");
  });
});

describe("evaluate: clean action", () => {
  it("allows a fully clean action with matchedRule null", () => {
    const result = evaluate(baseAction());
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toBe("Action satisfies all policy rules.");
  });

  it("applies the default config when no config is passed", () => {
    // amount 100 is under the default cap of 1000, so this is allowed.
    const result = evaluate(baseAction({ amount: DEFAULT_POLICY_CONFIG.maxAmount }));
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
  });
});

describe("evaluate: first deny wins (rule order)", () => {
  it("returns spendCap before denyList when both would deny", () => {
    const result = evaluate(
      baseAction({ amount: 5000, recipient: "0xBAD" }),
      { maxAmount: 1000, deniedRecipients: ["0xBAD"] },
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("spendCap");
    expect(result.reason).toBe(
      "Amount 5000 USDC exceeds the maximum allowed amount of 1000.",
    );
  });
});

// Tests on individual rule functions in isolation. These confirm a rule returns
// null when it passes and a RuleDenial when it denies, independent of evaluate.

describe("rule functions in isolation", () => {
  const config: PolicyConfig = { ...DEFAULT_POLICY_CONFIG };

  it("spendCap returns null when amount is at or under the cap", () => {
    expect(spendCap(baseAction({ amount: config.maxAmount }), config)).toBeNull();
  });

  it("spendCap returns a denial when amount is over the cap", () => {
    const denial = spendCap(baseAction({ amount: config.maxAmount + 1 }), config);
    expect(denial).not.toBeNull();
    expect(denial?.matchedRule).toBe("spendCap");
  });

  it("denyList returns null when the recipient is not on the deny-list", () => {
    expect(denyList(baseAction({ recipient: "0xOK" }), config)).toBeNull();
  });

  it("velocity returns null when no recentActionCount is provided", () => {
    expect(velocity(baseAction(), config)).toBeNull();
  });
});
