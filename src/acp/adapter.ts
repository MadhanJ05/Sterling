/**
 * Narrow adapter interface for Virtuals ACP.
 *
 * NOT IMPLEMENTED. Nothing in this file talks to ACP, and the only concrete class here refuses
 * every call. It exists so the shape of the integration is written down and so the blockers are
 * visible in code rather than only in prose. See docs/acp-status.md for what was verified, what
 * is missing, and why a working adapter cannot honestly be produced yet.
 *
 * Facts below were read from the pinned snapshot 2b45a88f7ef51d0d80b9425c63bb138e4522926b on
 * 14 September 2026 and must be re-verified against the deployed contract before use.
 */
import type { RecordRow } from "../shared/types.ts";
import type { AcceptancePack } from "../shared/pack.ts";

/** The deployed ACP job shape, from the pinned ABI's `jobs(uint256)` getter. */
export interface AcpJobView {
  client: string;
  status: number;
  provider: string;
  expiredAt: number;
  evaluator: string;
  hook: string;
  budget: bigint;
  description: string;
}

export interface AcpAcceptanceBinding {
  /** Our escrow's terms digest, which ACP has no field for. See docs/acp-status.md §3. */
  termsDigest: string;
  packDigest: string;
  sourceDigest: string;
  /** keccak256 of the canonical bundle. ACP stores whatever bytes32 the provider passes. */
  deliveryDigest: string;
}

export interface AcpAdapter {
  /** Create an ACP job with an explicitly chosen evaluator. Omitting it selects skip-evaluation. */
  createJob(input: {
    chainId: number;
    providerAddress: string;
    evaluatorAddress: string;
    expiredAt: number;
    description: string;
    hookAddress?: string;
  }): Promise<bigint>;

  /** Read the job back. Note: the submitted deliverable digest is NOT in this getter. */
  getJob(chainId: number, jobId: bigint): Promise<AcpJobView>;

  /**
   * Submit. ACP's `submit(uint256,bytes32,bytes)` takes a caller-supplied bytes32; the contract
   * does not compute it. Our adapter must pass the canonical-bundle digest, never a URL hash.
   */
  submit(chainId: number, jobId: bigint, rows: readonly RecordRow[]): Promise<AcpAcceptanceBinding>;

  /**
   * Recover the submitted digest. Only obtainable from the `JobSubmitted` event log, which is not
   * contract-readable storage. Any on-chain evaluator therefore cannot read it directly.
   */
  readSubmittedDigest(chainId: number, jobId: bigint): Promise<string | null>;

  /** Evaluate off ACP, using our own policy, and call ACP's terminal complete() or reject(). */
  evaluateAndSettle(input: {
    chainId: number;
    jobId: bigint;
    pack: AcceptancePack;
    source: readonly RecordRow[];
  }): Promise<{ verdict: "PASS" | "FAIL" | "INDETERMINATE"; txHash: string | null }>;
}

export class AcpIntegrationBlocked extends Error {
  constructor(readonly blocker: string) {
    super(
      `ACP integration is not implemented. Blocker: ${blocker}. ` +
      `See docs/acp-status.md. Nothing in this project has ever talked to ACP.`,
    );
    this.name = "AcpIntegrationBlocked";
  }
}

/**
 * The only implementation that exists. Every method throws. This is deliberate: a stub that
 * returned plausible values would let a demo look like an ACP integration while being nothing of
 * the kind, which is the exact failure mode the brief rules out.
 */
export class NotIntegratedAcpAdapter implements AcpAdapter {
  private fail(method: string): never {
    throw new AcpIntegrationBlocked(
      `${method}() requires a registered ACP agent identity and the deployed contract address on ` +
      `Base Sepolia. Neither is available in this environment, and obtaining them means registering ` +
      `an account, which is out of scope.`,
    );
  }
  createJob(): Promise<bigint> { this.fail("createJob"); }
  getJob(): Promise<AcpJobView> { this.fail("getJob"); }
  submit(): Promise<AcpAcceptanceBinding> { this.fail("submit"); }
  readSubmittedDigest(): Promise<string | null> { this.fail("readSubmittedDigest"); }
  evaluateAndSettle(): Promise<{ verdict: "PASS" | "FAIL" | "INDETERMINATE"; txHash: string | null }> {
    this.fail("evaluateAndSettle");
  }
}

/** Facts verified from the pinned snapshot. Kept in code so drift is visible in a diff. */
export const PINNED_ACP_FACTS = {
  snapshot: "2b45a88f7ef51d0d80b9425c63bb138e4522926b",
  readOn: "2026-09-14",
  createJobSignature: "createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) -> uint256",
  submitSignature: "submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
  jobsGetterOutputs: ["client", "status", "provider", "expiredAt", "evaluator", "hook", "budget", "description"],
  submittedDigestIsEventOnly: true,
  sdkHashesDeliverableString: "keccak256(toHex(params.deliverable)) in src/clients/evmAcpClient.ts",
  omittedEvaluatorSelectsSkipEvaluation: "evaluatorAddress ?? getNoEvaluatorAddress(chainId) in src/acpAgent.ts",
  singleExpiryField: "expiredAt only; no separate delivery deadline and settlement expiry",
  adminSurface: ["setProvider", "setPlatformFee", "setEvaluatorFee", "setHookWhitelist", "upgradeToAndCall", "grantRole"],
  upgradeable: "UUPS: proxiableUUID, upgradeToAndCall, UPGRADE_INTERFACE_VERSION, Upgraded event",
} as const;
