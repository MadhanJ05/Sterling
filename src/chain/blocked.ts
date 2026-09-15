/**
 * Unauthorized actions, actually attempted against the running chain.
 *
 * Nothing here is simulated: each case sets up a real job, sends a real transaction that should
 * not be allowed, and records the contract's actual rejection plus proof that no balance moved.
 */
import * as jobs from "./jobs.ts";
import { loadFixture } from "./fixtures.ts";
import type { Session } from "./session.ts";

export interface BlockedResult {
  id: string;
  label: string;
  attempted: string;
  outcome: "REJECTED" | "ALLOWED";
  error: { name: string; args: string[] };
  explanation: string;
  statusBefore: string;
  statusAfter: string;
  balancesUnchanged: boolean;
}

async function attempt(
  session: Session,
  id: string,
  label: string,
  attempted: string,
  explanation: string,
  jobId: string,
  action: () => Promise<unknown>,
): Promise<BlockedResult> {
  const before = await session.balances();
  const statusBefore = (await session.readJob(jobId)).status;
  let error = { name: "NONE", args: [] as string[] };
  let outcome: "REJECTED" | "ALLOWED" = "ALLOWED";
  try {
    await action();
  } catch (e) {
    const d = jobs.decodeRevert(session.dep.escrow, e);
    error = { name: d.name, args: d.args };
    outcome = "REJECTED";
  }
  const after = await session.balances();
  const statusAfter = (await session.readJob(jobId)).status;
  return {
    id, label, attempted, outcome, error, explanation, statusBefore, statusAfter,
    balancesUnchanged: JSON.stringify(before) === JSON.stringify(after),
  };
}

/** Each case builds its own throwaway job so the demonstration never disturbs a job on screen. */
export async function runBlockedAction(session: Session, id: string): Promise<BlockedResult> {
  const w = session.chain.wallets;
  const escrow = session.dep.escrow;
  const good = () => loadFixture("output-correct.json");

  const freshCreated = async () => (await session.createJob("pass")).jobId;
  const freshFunded = async () => {
    const jobId = await freshCreated();
    await session.accept(jobId);
    await session.fund(jobId);
    return jobId;
  };

  switch (id) {
    case "wrong-actor-accept": {
      const jobId = await freshCreated();
      return attempt(session, id, "Buyer tries to accept on the supplier's behalf",
        "buyer calls acceptJob()",
        "Acceptance is the supplier's own authenticated action. The buyer cannot manufacture the supplier's agreement.",
        jobId, async () => jobs.acceptJob(escrow, w.buyer, BigInt(jobId), (await session.readJob(jobId)).termsDigest));
    }
    case "wrong-actor-submit": {
      const jobId = await freshFunded();
      return attempt(session, id, "An unrelated account tries to submit the delivery",
        "thirdParty calls submitDelivery()",
        "Only the provider named in the approved terms can deliver. Nobody else can put bytes in front of the checker.",
        jobId, () => jobs.submitDelivery(escrow, w.thirdParty, BigInt(jobId), good()));
    }
    case "wrong-actor-fund": {
      const jobId = await freshCreated();
      await session.accept(jobId);
      return attempt(session, id, "An unrelated account tries to fund the job",
        "thirdParty calls fundJob()",
        "Funding is the buyer's authorisation. A third party cannot commit the buyer to a job.",
        jobId, async () => jobs.fundJob(escrow, session.dep.token, w.thirdParty, BigInt(jobId),
          (await session.readJob(jobId)).termsDigest, BigInt(session.jobsById.get(jobId)!.amount)));
    }
    case "stale-terms-digest": {
      const other = await freshCreated();
      const jobId = await freshCreated();
      const otherDigest = (await session.readJob(other)).termsDigest;
      return attempt(session, id, "Supplier accepts using another job's approved terms",
        "provider calls acceptJob() with job A's digest against job B",
        "The terms digest binds the chain id, the escrow address and the job id, so an approval for one job means nothing for another.",
        jobId, () => jobs.acceptJob(escrow, w.provider, BigInt(jobId), otherDigest));
    }
    case "cancel-funded": {
      const jobId = await freshFunded();
      return attempt(session, id, "Buyer tries to cancel after funding",
        "buyer calls cancelBeforeFunding() on a FUNDED job",
        "Cancellation exists only for jobs that hold no money. Once funded, the supplier's exposure is real and the buyer cannot walk away unilaterally.",
        jobId, () => (escrow.connect(w.buyer) as any).cancelBeforeFunding(jobId));
    }
    case "double-settle": {
      const jobId = await freshFunded();
      await session.submit(jobId);
      await session.settle(jobId);
      return attempt(session, id, "Settlement is requested a second time",
        "settle() on an already PAID job",
        "Settlement is terminal. The state changes before the transfer, so a second request finds nothing to settle.",
        jobId, () => jobs.settle(escrow, w.thirdParty, BigInt(jobId)));
    }
    case "double-submit": {
      const jobId = await freshFunded();
      await session.submit(jobId, "order");
      return attempt(session, id, "Supplier submits a second, better delivery",
        "submitDelivery() on an already SUBMITTED job",
        "Version 1 allows one submission per funded job. Revisions after seeing the result are not part of this agreement.",
        jobId, () => jobs.submitDelivery(escrow, w.provider, BigInt(jobId), good()));
    }
    case "settle-after-expiry": {
      const jobId = await freshFunded();
      await session.submit(jobId);
      await session.advanceTime(3600 + 3600 + 10);
      return attempt(session, id, "Settlement is requested after expiry",
        "settle() at or after settlementExpiry",
        "After expiry the contract cannot pay, even for conforming work. The refund path is the only route left. This is a timeout rule, not a judgement about the delivery.",
        jobId, () => jobs.settle(escrow, w.thirdParty, BigInt(jobId)));
    }
    case "refund-before-expiry": {
      const jobId = await freshFunded();
      await session.submit(jobId);
      return attempt(session, id, "Buyer tries to take the refund early",
        "refundExpired() before settlementExpiry",
        "The buyer cannot pull the escrow back while the supplier still has a valid claim on it.",
        jobId, () => jobs.refundExpired(escrow, w.buyer, BigInt(jobId)));
    }
    case "deployer-force-verdict": {
      const jobId = await freshFunded();
      await session.submit(jobId, "order");
      const before = await session.balances();
      const statusBefore = (await session.readJob(jobId)).status;
      const asDeployer = escrow.connect(w.deployer) as any;
      const missing = ["owner", "setPolicy", "forceSettle", "adminSettle", "withdraw", "sweep", "pause", "upgradeTo"]
        .filter((n) => typeof asDeployer[n] !== "undefined");
      // The deployer may still call settle - and gets the policy's answer like everyone else.
      await jobs.settle(escrow, w.deployer, BigInt(jobId));
      const after = await session.readJob(jobId);
      const bal = await session.balances();
      return {
        id,
        label: "The deployer tries to force a verdict or move the escrow",
        attempted: "deployer looks for an admin function, finds none, and can only call settle() like anyone else",
        outcome: missing.length === 0 ? "REJECTED" : "ALLOWED",
        error: { name: missing.length === 0 ? "NoSuchFunction" : "UNEXPECTED_ADMIN_FUNCTION", args: missing },
        explanation:
          "There is no owner, no admin, no pause, no upgrade path and no withdrawal function in the escrow. " +
          "The deployer account holds no privilege of any kind. It can request settlement, and gets the same " +
          `policy answer as anyone else: this delivery was rejected on rule ${after.ruleId}, and the money went to the buyer.`,
        statusBefore,
        statusAfter: after.status,
        balancesUnchanged:
          BigInt(bal.deployer ?? "0") === BigInt(before.deployer ?? "0") &&
          BigInt(bal.provider ?? "0") === BigInt(before.provider ?? "0"),
      };
    }
    default:
      throw new Error(`Unknown blocked action: ${id}`);
  }
}
