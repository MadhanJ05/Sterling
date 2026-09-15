/**
 * A demonstration meant to be clicked repeatedly must survive being clicked repeatedly.
 *
 * The buyer starts with 1,000 mUSD and each job locks 25, so the fortieth paid job emptied the
 * wallet and the forty-first failed with `missing revert data` — a token revert the escrow's
 * interface could not decode. Both halves of that are tested here: the session keeps going, and
 * any revert that does happen names itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Session } from "../src/chain/session.ts";
import * as jobs from "../src/chain/jobs.ts";
import { loadFixture } from "../src/chain/fixtures.ts";
import { buildPack } from "../src/shared/pack.ts";

describe("a long session", () => {
  let session: Session;
  beforeAll(async () => { session = await Session.start(); }, 240_000);
  afterAll(async () => { await session?.close(); });

  it("survives more paid jobs than the starting balance covers", async () => {
    // 44 jobs at 25 mUSD is 1,100 against a 1,000 starting balance.
    for (let i = 1; i <= 44; i++) {
      const job = await session.runAutomatic("pass");
      expect((await session.readJob(job.jobId)).status, `job ${i}`).toBe("PAID");
    }
    expect(session.topUps).toBeGreaterThan(0);

    // Every job still reports its own 25, unaffected by the refill.
    const last = [...session.jobsById.keys()].pop()!;
    const bundle = await session.exportEvidence(last);
    expect(bundle.balanceDeltas.provider).toBe("25000000");
    expect(bundle.balanceDeltas.buyer).toBe("-25000000");
    const { verifyBundle } = await import("../src/shared/evidence.ts");
    expect(verifyBundle(bundle).lines.filter((l) => !l.ok)).toEqual([]);
  }, 600_000);

  it("names a token revert instead of reporting 'missing revert data'", async () => {
    // Drain the buyer, then fund a job by hand so the token itself reverts.
    const token = session.dep.token as any;
    const balance = BigInt(await token.balanceOf(session.chain.addresses.buyer));
    await (await (token.connect(session.chain.wallets.buyer) as any)
      .transfer(session.chain.addresses.thirdParty, balance)).wait();

    const source = loadFixture("source-batch-1.json");
    const created = await jobs.createJob({
      escrow: session.dep.escrow, buyer: session.chain.wallets.buyer,
      provider: session.chain.addresses.provider, token: session.dep.addresses.token,
      amount: 25_000_000n, source,
      pack: buildPack({
        title: "Drained", source,
        payment: {
          tokenSymbol: "mUSD", paymentToken: session.dep.addresses.token, tokenDecimals: 6,
          amountBaseUnits: "25000000", deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
        },
      }),
      deliveryWindowSeconds: 3600, settlementWindowSeconds: 3600,
    });
    await jobs.acceptJob(session.dep.escrow, session.chain.wallets.provider, created.jobId, created.termsDigest);

    let decoded: { name: string; raw: string } | null = null;
    try {
      await jobs.fundJob(session.dep.escrow, session.dep.token, session.chain.wallets.buyer,
        created.jobId, created.termsDigest, 25_000_000n);
    } catch (e) {
      decoded = jobs.decodeRevert(session.dep.escrow, e);
    }
    expect(decoded, "funding a drained wallet should revert").not.toBeNull();
    expect(decoded!.name, `undecodable revert: ${decoded!.raw}`).not.toBe("UNKNOWN");
    expect(decoded!.name).toBe("InsufficientBalance");
  }, 180_000);
});
