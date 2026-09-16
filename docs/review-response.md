# Response to the independent review of 14 September 2026

The review was right on all five counts. Each finding is repaired, and each reproduction is now a
regression test in `tests/regression-review.test.ts` that failed before the repair and passes
after. Where a guarantee remains inherently limited, the limit is documented rather than argued
away.

Evidence that the tests failed first: the five findings produced 18 failures out of 20 tests when
run against the unrepaired code. The two that passed were the intended controls — a well-formed
agreement is still accepted, and the chain still works on loopback.

## P1 — the provider verified fingerprints, not the agreement's meaning

**Reproduced.** The real provider process accepted a pack with an unsupported subjective clause
(buyer claimed a count of zero), a pack advertising 25 test dollars against an on-chain amount of
1, and a pack naming a different source batch from the one stored.

**Repaired.** `src/shared/agreement.ts` is one strict validator, used before creation, before
provider acceptance, before funding, and inside evidence verification. It requires the pack —
`--pack` is now mandatory for `provider accept` — and rejects unknown formats, unsupported
policies, invented rule IDs, invalid coverage labels, and inconsistent fields. It compares source
digest, row count, rule mask, policy and version, amount, payment-token address, parties, chain,
escrow, and both deadline windows against what the contract actually stored.

Two structural changes fell out of this:

- **The pack now names the payment token by address** (`acceptance-pack/v2`). v1 named a symbol,
  and a symbol identifies nothing. A v1 pack is rejected, not silently upgraded.
- **`createJob` takes windows, not absolute deadlines**, and derives the deadlines from the block
  it mines in. Previously the client computed deadlines from a stale block, so the delivered window
  was a second or two short of what the pack promised and an exact check was impossible. Now
  `deliveryDeadline - createdAt` is exactly the promised window.

Executable clauses are derived from the supported template: a clause labelled `EXECUTABLE` must
carry exactly the template text for the rule it names. Arbitrary prose cannot borrow a rule's
authority.

**What remains limited.** The on-chain `unsupportedClauseCount` is still caller-supplied and the
contract still cannot parse a pack. Moving the label on chain would not change that. What closes
the gap is the client validator, which is a property of *this software*, not of the chain — a
counterparty running different software is protected by its own or not at all. And no validator can
prove that a sentence of English has been adequately captured by a check; it can only prove the
text is the template's text.

**Also corrected.** The review noted that the test titled "lying about the clause count does not
help: the digest then no longer matches the pack" asserted the opposite of its title and never
invoked the provider. The title was wrong: the digest *does* match, which is the whole point. That
test is now "an on-chain unsupported-clause count of zero is a bare claim the contract cannot
check", asserts what actually happens, and the end-to-end refusal is proven separately by spawning
the real provider process.

## P1 — an address with no token contract produced a false PAID

**Reproduced.** Setting the payment token to an ordinary account (code `0x`) let a job reach PAID
with no token contract in existence, because a low-level call to a codeless address succeeds with
empty return data.

**Repaired.** The escrow binds **one** payment token immutably at construction and requires code at
that address at that moment. `createJob` reverts with `UnsupportedPaymentToken` for anything else.
Transfers use OpenZeppelin `SafeERC20`, and the escrow verifies the exact balance delta in both
directions, so a token that delivers less than it promises reverts with `UnexpectedTokenAmount`.

**What remains limited.** Code existence does not make a token honest. Fee-on-transfer and
rebasing tokens are **unsupported** and revert; that is a restriction, not a defence. Broadening
asset support would need more than this.

## P1 — payment evidence did not verify the claimed payment

**Reproduced twice.** Rewriting the displayed provider, amount and status still gave `ok: true`.
Replacing the transaction list with an unrelated mock-token mint from a different chain instance
still printed "Bundle verified."

**Repaired.** The verifier now returns three separate verdicts and never collapses them:

| Section | Checks |
|---|---|
| rules reproduced | commitments recompute; the agreement validates against the terms; the recorded verdict is what the rules produce |
| bundle internally consistent | every repeated display value — recipient, amount, status, parties, job id, chain, escrow, token, verdict name, balance deltas — agrees with the terms the bundle carries |
| on-chain settlement | `--rpc` only: chain id; deployed code at the escrow, policy and token; the escrow's own `paymentToken()` and `policy()`; every recorded transaction addressed to a contract the bundle names **and** carrying a log for this job; the `JobFunded` and `JobSettled`/`JobExpired` events for this job with this verdict, recipient and amount; the settlement transaction present in the bundle's own list; and a token `Transfer` of the exact asset, amount and recipient |

Funding is verified as well as payout. Empty, duplicated and unrelated receipt sets all fail.
Without `--rpc` the third section prints **NOT CHECKED**, never passed. `--min-confirmations`
exists, defaults to 1 for an instant-mining local chain, and the verifier warns whenever it is
below 12.

**What remains limited.** On a disposable local chain the chain is operator-controlled, so this is
an integrity check and not third-party attestation.

## P2 — the local chain was not bound to loopback

**Reproduced.** `server.listen(port)` with no host produced a `*:<port>` listener, and the Vite
development websocket was on a wildcard too.

**Repaired.** The chain binds explicitly to `127.0.0.1`, and the Vite dev server and its HMR
websocket are given an explicit host. Three tests check the *effective* binding, not the intent:
the RPC refuses a connection on a non-loopback address of this machine, loopback still works, and
`lsof` shows a `127.0.0.1:` listener with no wildcard.

**What remains limited.** These tests establish binding behaviour on this machine. They do not
test firewall or network reachability, and the demo server still holds unlocked disposable keys —
it is a local development tool and nothing about it should be exposed.

## P2 — tests and a running demo overwrote each other's runtime metadata

**Reproduced.** A shared `build/runtime.json` meant a test or demo run silently repointed a live
app's agent subprocesses at a chain that had been shut down.

**Repaired.** Every session gets a unique id, its own `build/sessions/<id>/runtime.json`, its own
pack directory and its own evidence directory. `--runtime` is passed explicitly to every
subprocess, and there is no global default: an agent started without it exits with an error saying
so. `npm run demo` writes to the stable `evidence/demo/` so documented paths do not move.

Three tests cover it: two simultaneous sessions keep separate chains, runtimes and evidence and
each session's agents reach its own chain; a live session still works after another has started and
stopped; and an agent refuses to run without `--runtime`.

## Section 5 — the recommended next steps

**Submit and settle together.** Implemented as `submitAndSettle(jobId, rows)`. Error behaviour was
fixed before implementation: an evaluation that cannot complete reverts the whole transaction and
records nothing, so the provider may retry either path up to the delivery deadline, after which the
agreed expiry refund applies. No admin override was added. Existing jobs keep their policy and
version; changed semantics would need a new deployment. The provider previews its output before
submitting and refuses work that fails its own check unless `--demonstrate-nonconforming` is passed
explicitly, which only the demonstration scenarios do.

**Reduced on-chain storage, as a separate measured experiment.**
`contracts/experimental/CommitmentEscrowExperiment.sol` stores commitments rather than rows and is
handed the rows at settlement, rehashing them before evaluating. It is not used by the application
and is not deployed by `npm start` or `npm run demo`. Verification was not weakened to buy gas:
mis-bound source or delivery rows revert with `SourceDataMismatch` / `DeliveryDataMismatch` and can
never become a FAIL that refunds an honest provider's job — `tests/storage-experiment.test.ts`
tests exactly that attack, including a hostile third party trying to swap in a failing delivery.
`npm run benchmark` compares all three paths; the numbers are in `docs/limitations.md` §7.

**Automation as the primary experience.** The home screen now leads with **Run an automatic job**,
which runs the whole flow and fills a timeline as it goes, with **Inspect each step** as a separate
action. Fixtures, the agent processes and the attack scenarios moved into a collapsed *Advanced
demonstration* panel. Parties are labelled "Buyer" and "Provider" with addresses on expansion.
Explanatory-text contrast was raised. A batch-import box accepts a few rows and rebinds the fixed
template to them, demonstrating reuse rather than another hard-coded example — and the interface
says plainly that only one template is supported.

**Official ACP** remains a separate milestone and is still **not integrated**.

## One correction to our own earlier report

The review was right that a `setProvider` entry in an ABI does not prove a payment recipient can
change after funding. Our previous report said in bold that it could. That is withdrawn and
corrected in `docs/acp-status.md`: the ABI shows only that the function exists, the ERC-8183 draft
restricts the equivalent operation to the Open state, and establishing actual behaviour requires
reading the deployed implementation, which was not read. Upgradeability is a trust assumption worth
stating; neither it nor an admin function is by itself a vulnerability.

---

# Response to the second independent review, 14 September 2026

The second review was right on all five counts. Each finding is repaired and each reproduction is
now a regression test in `tests/regression-rereview.test.ts`. Run against the unrepaired code, 13 of
those 19 tests failed; the 6 that passed were the intended controls.

## F1 — genuine receipts authenticated a fabricated agreement

**Reproduced.** Starting from a real completed job, every price in both the source and the delivery
was shifted by 777 cents and every dependent hash — source, pack, terms, delivery — recomputed. The
bundle was internally perfect and kept the genuine receipts. The CLI with `--rpc` against the live
chain exited 0 and printed "on-chain settlement verified". A second forgery replaced the buyer in
both the display and the embedded terms and also passed.

Offline checks cannot catch this by construction: the file is self-consistent. The previous
implementation checked the settlement event's amount, recipient and verdict, but never compared the
bundle's commitments to the job the chain actually stored.

**Repaired.** The `--rpc` section now reads the stored job and compares it field by field: terms
digest, source commitment, pack commitment, delivery commitment, both parties, payment token,
amount, row count, policy id and version, rule mask, both deadlines, status, verdict, failing rule,
fail code and both verdict details. It also reads the stored source and output **rows** and checks
that the bundle's rows hash to the same thing. The token's `decimals()` is checked against the pack.
The expiry-refund branch gained the token-transfer check the settlement branch already had.

**Regression tests:** both copies rewritten with all hashes recomputed; buyer rewritten in both
places; deadlines rewritten consistently; pack rewritten consistently; source and delivery swapped
for a genuinely different job's; plus a valid control and an expiry control.

**What remains limited.** On a disposable local chain the chain is operator-controlled, so this is
an integrity check and not third-party attestation. An offline bundle with no `--rpc` still proves
only that it is self-consistent, and the verifier says exactly that.

## F2 — an imported batch could be funded but never delivered

**Reproduced.** Import three rows, accept, fund, then call either submission method:
`Cannot read properties of undefined (reading 'outputFixture')`. The job stayed FUNDED. Both methods
looked up a built-in scenario by the job's `scenarioId` and read `outputFixture` unconditionally;
an imported job has `scenarioId: "imported"` and no such scenario exists.

**Repaired.** There is now one delivery function. It always transforms **the job's own source** with
the supported transform, so an imported batch behaves exactly like a built-in fixture. A deliberate
defect is an explicit argument, never inferred from a job's name; the scenario table declares its
defect in one place. `runAutomaticForJob` gives an existing job the same one-click path as the
built-in example, and the interface's import button now runs it through to payment.

**Regression tests:** an imported batch settles through `submitAndSettle`, through the two-step
path, and through the automatic path; a deliberate defect still produces a genuine FAIL; and every
built-in scenario still reaches its documented outcome on the new delivery path. The browser test
now imports IDs 8801–8803 — present in no fixture — and carries them through payment, evidence
verification and the delivered rows, rather than stopping at "an agreement was created".

## F3 — the automatic runner revised unsupported scope by itself

**Reproduced.** `runAutomatic("unsupported-scope")` created a revised pack, funded it and refunded
it on expiry. The clause was marked `EXCLUDED_BY_REVISION` and the history described an explicit
revision that no caller had requested. The cause was an unconditional `reviseScope: true`.

**Repaired.** `createJob` refuses an agreement that is not fully automatic, throwing
`ScopeRevisionRequired` **before anything is created and before any money moves**. The error carries
`previewScopeRevision()`: the exact revised pack and its digest. To proceed, a caller passes that
digest back as `approvedPackDigest`; an approval naming a different pack is rejected. The API
surfaces this as a structured 400, and the interface shows the clause, the pack version and the
digest being approved before offering the button.

**Regression tests:** unsupported scope through the automatic path is refused with no job created
and no balance change; an approval naming the right pack succeeds; an approval naming a different
pack is rejected; and an ordinary conforming job still runs with no extra approval.

## F4 — the pack's token precision could contradict the asset

**Reproduced.** The real provider CLI accepted an agreement declaring 0 decimals for a token that
reports 6. Base units matched, so the transfer was unaffected, but the agreement described
25,000,000 mUSD where the contract meant 25.

**Repaired.** The validator takes `approvedTokenDecimals`, read from the token itself. The buyer and
provider both read `decimals()` from the approved asset and refuse a pack that disagrees
(`PAYMENT_DECIMALS_MISMATCH`). The RPC evidence verifier checks the same thing.

**What remains limited.** This works because the MVP supports one known asset per escrow. A general
token-metadata story is out of scope and was not built.

## F5 — an outgoing fee produced PAID with the provider short-changed

**Reproduced.** A token that credits the escrow in full on `transferFrom` but skims 10% on
`transfer` let a job promising 25,000,000 base units reach PAID while the provider received
22,500,000. `_push` checked how much left the escrow, not how much arrived.

**Repaired.** `_push` now checks both legs: the escrow must be debited by exactly the amount **and**
the recipient credited by exactly the amount. The same fix was applied to the experimental contract
so its payout behaviour matches. `contracts/testonly/OutgoingFeeToken.sol` is the review's token,
kept as a test fixture; settlement against it now reverts atomically with `UnexpectedTokenAmount`,
nothing is recorded and the escrow stays whole.

The documentation claim that "a token delivering less always reverts" was false when written. It is
now true, and the wording in `docs/limitations.md` says precisely which two legs are checked.

**Cost:** about 1,950 extra gas per settlement. The benchmark was re-run after the change.

## Section 5 design points

- **One delivery function** — done, as part of F2.
- **Imported jobs use the automatic path** — done, `runAutomaticForJob` plus `/api/job/:id/auto`.
- **The timeline is not streamed.** Correct, and the claim is withdrawn rather than the subsystem
  built. The server accumulates a log and returns it on completion; the interface shows a busy
  indicator and then the log, and says "it is a log, not a live feed". The browser checks were
  renamed from "as it happens" to "the completed run lists every step it took", and the two-agent
  check from "stream their own output" to "report their own output".
- **The storage experiment is not a storage-only comparison.** Correct, and the contract's own
  comment saying storage was "the only difference" was too strong. It now lists what else it omits
  relative to `AcceptanceEscrow` — stored terms digest, `expectedTermsDigest` arguments on
  acceptance and funding, policy id/version fields, three timestamps, `previewSettlement`,
  `termsDigestOf`, cancellation before funding, and several `createJob` validations — and states
  that parity work and re-measurement would be required before promoting it. It stays out of the
  application.
- No expansion into arbitrary English clauses, more asset types, a marketplace, or ACP.

---

# Response to the third independent review, 14 September 2026

Two findings, both reporting defects, both repaired. No contract changed: the reviewed contract
source hash `9ad637cdd8cefea95fd4f0f82a1972597fa4a041b588e3452744b60df65a5070` is unchanged, so the
benchmark is unaffected and was not re-run. Regression tests are in `tests/regression-round3.test.ts`;
9 of its 13 failed before the repairs, the other 4 being controls.

## R1 — a later job changed an earlier job's reported payment

**Reproduced.** Job A pays 25 test dollars. Job B later pays another 25. Re-exporting A's evidence
reported the provider as having earned **50 on A**, and A's genuine evidence then failed both the
offline consistency check and the RPC check. Two jobs funded before either settled were worse: each
included the other's deposit, so no end-of-job snapshot would have fixed it either.

**Cause.** `exportEvidence` computed each job's "balance changes" as *(wallet balance now − wallet
balance when the job was created)*. That measures everything that happened in between. The summary
panel, payment inspector and sidebar used the same subtraction.

**Repaired.** `Session.observedTransfersFor(jobId)` reads **that job's own transaction receipts**,
takes the approved token's `Transfer` events involving this escrow, reads each transaction hash
once, and records every movement with its transaction and log index. `balanceDeltas` is the net of
exactly those movements. No wallet balance is consulted anywhere in the derivation.

The bundle now carries `observedTransfers` (the movements themselves) alongside `balanceDeltas`
(their net), and `currentWalletBalances` as a separately labelled context field. The UI reads the
same server-derived figures; the sidebar was retitled **Current wallet totals** and says it covers
every job in the session.

Verification gained both halves. Offline: every movement must belong to a recorded transaction, no
(transaction, log) pair may appear twice, movements must involve this escrow and this token, the
reported deltas must equal the movements they come from, and a terminal job must show exactly one
funding in and one payout out, for the agreed amount, to the right party. With `--rpc`: the
movements are recomputed from the chain and compared — the receipts are read and added up, not
assumed, so a bundle that merely asserts the right figure fails.

**Regression tests:** complete A, complete B, re-export A; fund C and D then settle only C; a
rejected job; an expiry refund; an unrelated mint and transfer; the combined submit-and-settle
receipt counted once; and current wallet totals demonstrably differing from the job's own figures.
The browser test now revisits job #1 after jobs #2 and #3 have completed and checks both that it
still reports +25 and that its evidence still verifies.

## R2 — fabricated submission and settlement timestamps passed verification

**Reproduced.** Changing only `job.submittedAt` and `job.settledAt` — placing the alleged
submission a day after the settlement expiry — still produced "rules reproduced · bundle internally
consistent · on-chain settlement verified" and exit 0. The stored-job comparison added in the
previous round checked commitments, parties, deadlines, status and verdict, but not the timestamps.

**Repaired.** The RPC comparison now includes `createdAt`, `submittedAt` and `settledAt` against
the stored job, which is what establishes them. Offline, the timestamps are additionally checked
for internal possibility: ordering, and the deadlines the contract enforces — a submission after
the delivery deadline, or a settlement at or after expiry, is impossible and is rejected without a
chain. An expired job that was never delivered carries `submittedAt: 0`, and that unset value is
verified rather than waved through.

**Regression tests:** each timestamp mutated independently, in both directions, including plausible
earlier values; the review's exact "one day after expiry" case; a phantom submission claimed on an
expired job; an offline-only impossible ordering; and valid paid, rejected and expired controls.

**What this never was.** The forgery could not cause a late submission to the actual contract or
undo the previous round's content binding. The contract's deadlines were always enforced. What was
wrong was the exported record's account of *when*, which for an evidence product is the point.

## One further misattribution found while testing the fix

Inspecting the new browser screenshot showed the job panel headed **Job #1** with **job #3's**
evidence rendered underneath it. An exported bundle was kept in component state when the selected
job changed, so the two could drift apart. The browser check had passed because it matched on
"rules reproduced: pass", which was true of the stale bundle.

Same class of defect as R1 — one job's figures presented under another job's heading — so it is
fixed the same way rather than left for a fourth round. The bundle is cleared when the selection
changes, and the evidence panel refuses to render beside a job it does not belong to. The browser
check now waits for the panel to actually be job #1 and asserts the bundle says
`displayed job id matches the terms — job 1 vs terms 1` and reports its own 25,000,000.

## Scope

Limited to these two defects and that one, as asked. No contract architecture change, no ACP integration, no
public deployment. All five earlier repairs and the imported-batch flow are preserved and still
covered by their own tests.

---

# Response to the fourth independent review, 14 September 2026

One finding, repaired. No Solidity changed: the contract source hash is still
`9ad637cdd8cefea95fd4f0f82a1972597fa4a041b588e3452744b60df65a5070`, so the benchmark is unaffected
and was not re-run. Regression tests are in `tests/regression-round4.test.ts`; 3 of its 12 failed
before the repair, and the other 9 were controls or cases the existing checks already caught.

## The finding — summaries were never reconciled with their movements

**Reproduced.** Starting from a genuine paid job for 25,000,000 base units:

1. Remove every movement, zero every net balance change, leave `fundedIn`/`paidOut`/`paidTo`
   claiming a full payment. Offline verification passed.
2. Halve every movement and every net balance change, leave the summaries claiming the full amount.
   Offline verification passed.

Both are contradictions *inside the bundle*; no chain is needed to see them. The offline checker
recomputed net balance changes from `observedTransfers.transfers`, and separately compared the
supplied summaries with the agreement, but never compared the two.

**Repaired.** `src/shared/transfers.ts` holds one pure derivation: totals in and out, the recipient,
each movement's direction, the movement counts, and the per-role net. Three callers use it:

- the exporter, to produce its summary (so it cannot assemble one separately and drift);
- the offline checker, to re-derive the summary from the movement list and compare every supplied
  field against it;
- the RPC checker, on a movement list it builds itself from chain receipts, so that comparison owes
  nothing to what the bundle asserts.

Direction is derived from the escrow and the from/to addresses. A supplied direction is compared
with the derived one and a contradiction is an error. Duplicate `(transaction, log)` identifiers,
negative or non-integer values, movements that do not involve the escrow, and the escrow paying
itself are all structural errors that make the whole list untrustworthy.

The derived result is then checked against the agreement and the job's state:
`expectedMovementCounts` requires 0 in / 0 out for CREATED, ACCEPTED and CANCELLED; 1 / 0 for FUNDED
and SUBMITTED; and 1 / 1 for PAID, REJECTED and EXPIRED. A terminal job must show the agreed amount
funded in and the agreed amount out to the party its outcome requires — derived, not claimed.

The exporter now refuses to produce a bundle at all if its own movements are inconsistent, rather
than emitting one that later fails verification.

**Regression tests.** The review's empty-list and half-amount cases; a summary naming a recipient
the movements do not show; a supplied direction contradicting its addresses; duplicated movement
identifiers; an inflated `fundedIn`; an understated `paidOut`; a terminal paid job with no payout
movement; one with no funding movement; a refunded job whose movements show the provider being
paid; and a check that the exporter's own summaries equal what its movements derive to. Genuine
paid, rejected and expired bundles are controls, asserted to pass the offline library, the offline
CLI **and** the RPC path. Every mutation is asserted to fail all three, so closing the offline gap
cannot have been done by weakening the chain checks.

**Scope, stated as the review stated it.** This was an incorrect claim of internal consistency. It
was never an ability to forge a chain-verified payment or to move funds: the RPC comparison caught
both alterations throughout, and offline verification always labelled on-chain settlement NOT
CHECKED.

## One stale assertion found while verifying

Renaming a verification line broke a browser check that matched its old wording. Fixed, and the
check was tightened to assert the reconciliation lines by name as well as the amount.

## Scope

Limited to this correction. No contract change, no new features, no ACP integration, no public
deployment. Per-job accounting, the timestamp comparison, the selected-job evidence guard and all
earlier repairs are preserved and still covered by their own tests.
