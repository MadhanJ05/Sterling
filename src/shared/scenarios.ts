/** Demo scenarios. Pure metadata: no file access, so the browser can import it too. */

/** The deliberate defects a demonstration can inject. Never selected implicitly. */
export type FlawKind = "none" | "order" | "price" | "drop" | "invent";

export interface Scenario {
  id: string;
  label: string;
  short: string;
  sourceFixture: string;
  /**
   * The committed fixture this scenario's delivery must equal. It is an assertion target, not the
   * delivery path: the supplier always transforms the job's own source, so an imported batch works
   * exactly like a built-in one. tests/checker-fixtures.test.ts pins the equivalence.
   */
  outputFixture: string | null;
  /** The defect to inject. "none" means an honest delivery. */
  flaw: FlawKind;
  includeSubjectiveClause: boolean;
  submit: boolean;
  expectedTerminalStatus: "PAID" | "REJECTED" | "EXPIRED" | "BLOCKED_AT_CREATION";
  expectedRuleId: number;
  explanation: string;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "pass",
    label: "Conforming delivery",
    short: "Supplier returns exactly what was agreed. Payment is released.",
    sourceFixture: "source-batch-1.json",
    outputFixture: "output-correct.json",
    flaw: "none",
    includeSubjectiveClause: false,
    submit: true,
    expectedTerminalStatus: "PAID",
    expectedRuleId: 0,
    explanation: "All four agreed rules hold, so the contract pays the supplier.",
  },
  {
    id: "fail-order",
    label: "Right data, wrong sort",
    short: "Every row correct, but two products are out of order. Buyer is refunded.",
    sourceFixture: "source-batch-1.json",
    outputFixture: "output-wrong-order.json",
    flaw: "order",
    includeSubjectiveClause: false,
    submit: true,
    expectedTerminalStatus: "REJECTED",
    expectedRuleId: 4,
    explanation:
      "The substance is entirely right and only the agreed ordering is wrong. This is the case a human reviewer would most often wave through, and the one an evaluator asked to judge freely is least consistent on.",
  },
  {
    id: "fail-price",
    label: "A price was altered",
    short: "One price differs from the approved source. Buyer is refunded.",
    sourceFixture: "source-batch-1.json",
    outputFixture: "output-wrong-price.json",
    flaw: "price",
    includeSubjectiveClause: false,
    submit: true,
    expectedTerminalStatus: "REJECTED",
    expectedRuleId: 3,
    explanation: "Product 1009 was delivered at 3490.00 against an approved 3499.00.",
  },
  {
    id: "fail-rowcount",
    label: "A row is missing",
    short: "Eleven rows delivered against an agreed twelve. Buyer is refunded.",
    sourceFixture: "source-batch-1.json",
    outputFixture: "output-missing-row.json",
    flaw: "drop",
    includeSubjectiveClause: false,
    submit: true,
    expectedTerminalStatus: "REJECTED",
    expectedRuleId: 1,
    explanation: "Row count is checked first, so this is reported against rule 1.",
  },
  {
    id: "fail-unknown-id",
    label: "An invented product",
    short: "A product that was never in the source appears in the delivery. Buyer is refunded.",
    sourceFixture: "source-batch-1.json",
    outputFixture: "output-unknown-id.json",
    flaw: "invent",
    includeSubjectiveClause: false,
    submit: true,
    expectedTerminalStatus: "REJECTED",
    expectedRuleId: 2,
    explanation: "Product 9999 is not in the approved source.",
  },
  {
    id: "expiry",
    label: "Nothing delivered",
    short: "Supplier never submits. After expiry the buyer recovers the escrow.",
    sourceFixture: "source-batch-1.json",
    outputFixture: null,
    flaw: "none",
    includeSubjectiveClause: false,
    submit: false,
    expectedTerminalStatus: "EXPIRED",
    expectedRuleId: 0,
    explanation:
      "Refund after expiry is a timeout rule. It is not a finding that the work was bad, and the interface says so.",
  },
  {
    id: "unsupported-scope",
    label: "A clause software cannot check",
    short: "The pack contains \"make the descriptions persuasive\". The job cannot be created.",
    sourceFixture: "source-batch-1.json",
    outputFixture: "output-correct.json",
    flaw: "none",
    includeSubjectiveClause: true,
    submit: false,
    expectedTerminalStatus: "BLOCKED_AT_CREATION",
    expectedRuleId: 0,
    explanation:
      "The contract refuses a job whose pack still carries a clause classified as requiring judgement. The clause is shown, not dropped. Moving forward requires an explicit scope revision that both parties can read.",
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export const BLOCKED_ACTIONS = [
  { id: "wrong-actor-accept", label: "Buyer tries to accept on the supplier's behalf" },
  { id: "wrong-actor-submit", label: "An unrelated account tries to submit the delivery" },
  { id: "wrong-actor-fund", label: "An unrelated account tries to fund the job" },
  { id: "stale-terms-digest", label: "Supplier accepts using another job's approved terms" },
  { id: "cancel-funded", label: "Buyer tries to cancel after funding" },
  { id: "double-settle", label: "Settlement is requested a second time" },
  { id: "double-submit", label: "Supplier submits a second, better delivery" },
  { id: "settle-after-expiry", label: "Settlement is requested after expiry" },
  { id: "refund-before-expiry", label: "Buyer tries to take the refund early" },
  { id: "deployer-force-verdict", label: "The deployer tries to force a verdict or move the escrow" },
] as const;

export type BlockedActionId = (typeof BLOCKED_ACTIONS)[number]["id"];
