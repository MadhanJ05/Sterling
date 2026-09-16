# Limitations

Written to be read by someone looking for the weak points, and to save them the trouble.

## 1. What this does not prove

- **Nothing about demand.** No customer was interviewed, no pilot exists, no loss was measured. The
  brief deliberately deferred that work. Passing every test here demonstrates engineering
  behaviour and nothing else.
- **Nothing about whether checking is cheaper than fulfilment.** The catalogue-normalisation job is
  *deliberately trivial to perform* — it is a mechanism fixture, not a business case. Writing the
  acceptance pack for it plainly costs more than doing the work. Whether authoring cost amortises
  across repeated jobs on a *real* recurring deliverable is untested and is the live commercial
  risk. Any timing recorded here is an engineering measurement, not a customer saving.
- **Nothing about dispute rates.** This project makes no claim about how often evaluators disagree.
- **No competitive claim.** AgentCourt, BNB APEX, ADRP, TessPay, Taste and Promptfoo all exist in
  this space. Taste reports a live ACP evaluator integration. Do not claim the field is empty.

## 2. Scope frozen for version 1

- One job template, four rules, no rule configuration. The mask is bound into the terms digest and
  `createJob` rejects any value but `0x0F`, so a later version cannot silently reinterpret an old
  job — but equally, version 1 cannot express anything else.
- `(uint32 productId, uint64 priceCents)` only. No text, no dates, no nested structure, no
  floating point anywhere.
- Maximum 32 rows. The on-chain checks are O(n²), which is fine at 32 and would not be at 10,000.
- One submission per funded job. No revisions, no partial delivery, no milestones, no bonds, no
  appeal, no arbitration, no dispute window.
- JSON import rejects integers above `2^53−1` even though the encoding holds `uint64`. This is a
  documented refusal rather than a silent rounding — `docs/encoding.md` §5.

## 3. What the commitment actually covers

The settlement commitment covers the **canonical typed bundle**, not an uploaded file byte for
byte. Whitespace, key order and duplicate-key resolution in a JSON file are not protected. Calling
this "byte-for-byte verification of the delivered file" would be wrong.

The source records are an **agreed reference**, not independently verified facts about the world.
If both parties approve a wrong price, the checks will happily enforce the wrong price. This is the
endogenous-fact boundary: "do these bytes satisfy this committed predicate" is answerable here;
"is this the right predicate" is not, and never will be.

## 4. Trust that remains

- **The operator controls everything.** Buyer, provider, deployer, unrelated account, the chain and
  the clock are all one person. Nothing here is an arms-length transaction. The interface says this
  on every screen.
- **The chain is disposable and local.** `advanceTime` calls `evm_increaseTime`. There is no
  real-world counterpart to a button that moves time.
- **The local checker has no authority, and neither does the web app.** Both display results; the
  contract computes the one that moves money. If they ever disagreed, the contract would win and
  the discrepancy would be a bug — `tests/checker-parity.test.ts` exists to catch it.
- **Refund after expiry is a timeout, not a judgement.** A perfectly conforming delivery loses its
  payment if nobody requests settlement in time. This is a real property of the design, shown in
  the interface and tested at both boundaries.
- **No audit.** These contracts have had no security review. They are a prototype.

## 5. Known technical weak points

- **`INDETERMINATE` leaves a job pending until expiry.** This is deliberate — the alternative is an
  admin override, which would defeat the point — but it means a job with a broken policy is stuck
  until the clock runs out, and the buyer bears that wait. Tested with both an always-indeterminate
  and an always-reverting policy.
- **The policy is called with the transaction's remaining gas.** If evaluation ran out of gas, the
  63/64 rule means the `catch` would likely also fail and the whole transaction would revert rather
  than degrade to `INDETERMINATE`. At 32 rows this is far from the limit; at a larger bound it
  would need explicit gas budgeting.
- **`unsupportedClauseCount` is client-supplied, and always will be.** The contract cannot parse a
  pack, so it binds the digest and trusts the number. A caller can pass zero for a pack whose own
  coverage report says otherwise. Moving the count on chain would not fix this: a caller-supplied
  label is a caller-supplied label wherever it is stored.

  What does close it, for a party running this software, is `src/shared/agreement.ts`. Every client
  here validates the pack the digest actually commits to before creating, accepting or funding, and
  refuses on the pack's contents rather than on the count. `tests/regression-review.test.ts` proves
  the refusal by spawning the real provider process.

  **The residual limit is real and is not removed by any of that:** this is a property of the
  client, not of the chain. A counterparty running different software is protected by its own
  software or not at all. An earlier version of this document claimed the provider program checked
  this; at the time it did not, which the independent review demonstrated by spawning it. It does
  now, and the claim is backed by a test that spawns the process rather than by prose.

- **The validator cannot read English.** It proves that a clause labelled `EXECUTABLE` carries
  exactly the template text for the rule it names — a real, checkable property that stops arbitrary
  prose from borrowing a rule's authority. It cannot prove that a sentence has been *adequately*
  captured by a check, and nothing in this design ever will. Subjective promises stay
  `JUDGEMENT`, stay visible, and block the automatic flow.
- **`MockUSD.mint` is unrestricted.** Intentional: it means no account holds a privileged role. It
  also means the token is obviously not money.
- **One escrow serves exactly one payment token.** The token is fixed immutably at construction and
  the constructor requires code at that address. Earlier, any address the buyer named was accepted,
  and because a call to a codeless address succeeds with empty return data, a job could reach PAID
  with no token contract in existence — demonstrated by the independent review. Transfers use OpenZeppelin `SafeERC20`, and every movement is
  checked on **both** legs: what left the sender and what arrived at the recipient. Checking only
  the debit was not enough — a second review deployed a token that took the full amount from the
  escrow and delivered 90% of it, and the job reached PAID with the provider short-changed. Such
  tokens now revert. They are **not supported**, which is a restriction rather than a defence: code
  existence does not make an arbitrary token honest, and supporting a broader set of assets would
  need more than this.
- **Session isolation is per process, not per machine.** Each session writes its own
  `build/sessions/<id>/runtime.json` and its own evidence directory, and every agent subprocess is
  given `--runtime` explicitly; there is no global default and agents refuse to start without it.
  Two concurrent sessions are tested. Nothing coordinates *across* machines, and nothing stops a
  user pointing two sessions at the same port.
- **The escrow test file shares one chain across its tests, so a stall cascades.** In one full-suite
  run out of four, a test that normally takes ~1.2 s stalled for 217 s under machine load, blew the
  120 s timeout, and left two subsequent tests in the same file failing on state the timed-out test
  had half-applied. The file passes in isolation and on repeat runs, and no product behaviour is
  implicated — but the suite is not robust to a stalled local chain, and a single red run of
  `tests/escrow-flow.test.ts` should be re-run before it is believed. Giving each test its own
  chain would fix it at a large cost in suite runtime.
- **One session, no persistence.** Restarting the server starts a new chain and forgets every job.
  The web app recovers correctly from a refresh *within* a session and repeats no financial action,
  which is tested; it cannot recover across restarts because there is nothing to recover from.

## 5a. What the evidence bundle now establishes, and what it still cannot

A bundle answers three questions, reported separately and never collapsed:

| Question | Established by |
|---|---|
| Rules reproduced | offline replay: rows hash to the commitments, the agreement validates against the terms, the recorded verdict is what the rules produce |
| Bundle internally consistent | offline: every value the bundle repeats for a reader — displayed recipient, amount, status, parties, chain, addresses — agrees with the terms it also carries; **every movement summary is re-derived from the movement list it claims to summarise**, and the movement count matches what the job's state requires; and the timestamps are internally possible under the agreed deadlines |
| On-chain settlement verified | only `--rpc`: the right chain; the deployed contracts; the token's own `decimals()` against the pack; **the stored job itself — its terms digest, source, pack and delivery commitments, both parties, asset, amount, row count, policy, rule mask, both deadlines, status, complete verdict and all three timestamps, plus the stored rows themselves — compared against the bundle**; this job's cash movements recomputed from its own receipts and compared with the reported balance changes; each transaction addressed to a contract the bundle names *and* carrying a log for this job; the escrow's own settlement or expiry event with this verdict, recipient and amount; that transaction present in the bundle's own list; and a token `Transfer` of the exact asset, amount and recipient — on the refund branch as well as the payout branch |

Without `--rpc` the third is reported **NOT CHECKED**. It is never reported as passed.

Two rounds of forgeries are now regression tests. The first round rewrote a display field so it
contradicted the terms in the same file. The second was harder and more important: it rewrote
**both** copies of a value and recomputed every dependent hash, so the bundle was internally
perfect, and kept the genuine receipts. Offline checks cannot catch that by construction — the file
is self-consistent. Only comparing it against the job the chain actually stored can, which is why
the whole stored job is now read and compared field by field. An earlier version checked the
settlement event's amount, recipient and verdict but never bound the bundle's commitments to the
stored job, so genuine receipts authenticated a fabricated agreement.

Still not established, and not fixable by better checking:

- On this disposable local chain, the chain itself is operator-controlled. Receipt verification is
  an integrity check, not third-party attestation.
- Confirmation depth defaults to 1, which is right for an instant-mining local chain and wrong for
  a public one. `--min-confirmations` exists and the verifier warns whenever it is below 12.
- Whether the source data is true of the world. It is an agreed reference, not a verified fact.

## 5c. A job's figures are its own

A job's reported cash movements are derived from **that job's own transaction receipts**: the
approved token's `Transfer` events involving this escrow, in the transactions this job recorded,
each transaction read once. Nothing consults a wallet balance.

The earlier implementation computed them as *(wallet balance now − wallet balance when the job was
created)*. That measures everything that happened since, not what this job did. A second job
completing made the first report double; two jobs funded before either settled made each include
the other's deposit; and the inflated figures then failed the bundle's own consistency check, so a
genuine completed job's evidence was rejected. The third review reproduced all of this.

Wallet totals are still shown, in a panel labelled **Current wallet totals**, with a line saying
they cover every job in the session. The two views are deliberately not the same number.

A related misattribution was found while testing this fix and repaired with it: an exported bundle
survived a change of selected job, so the interface could show one job's heading above another
job's evidence. The bundle is now cleared on selection change and the panel will not render beside
a job it does not belong to.

The RPC verifier recomputes the movements from the chain and compares them with what the bundle
claims. It does not assume the expected amount — it reads the receipts and adds them up, so a
bundle that simply asserts the right figure without matching receipts fails.

**One calculation, three users.** `src/shared/transfers.ts` derives the totals, the recipient, the
direction of each movement and the per-role net from a movement list. The exporter uses it to
produce its summary, the offline checker uses it to re-derive that summary from the movements and
compare, and the RPC checker uses it on a list it builds itself from receipts.

That third point was a real gap for one round. The offline checker recomputed the net balance
changes from the movements and *separately* compared the supplied `fundedIn`/`paidOut`/`paidTo`
against the agreement — but never checked that those summaries came from those movements. A bundle
with no movements at all, or with every movement halved, could therefore still claim a full payment
and be called internally consistent. Both are now regression tests, and both fail offline without
needing a chain.

A movement's direction is always derived from the escrow and the from/to addresses. A supplied
direction is compared against the derived one and a contradiction is an error, never a hint.

## 5d. Timestamps are content, not decoration

`createdAt`, `submittedAt` and `settledAt` are compared against the stored job by the RPC check.
Offline, they are checked for internal possibility: ordering, and the deadlines the contract
enforces — a submission after the delivery deadline or a settlement at or after expiry is
impossible and is rejected without a chain.

Previously they were carried in the bundle and never compared to anything. A bundle could claim
work was delivered a day after the settlement deadline and paid later still, and the verifier
printed "on-chain settlement verified". That never permitted a late submission to the actual
contract — the contract's deadlines were always enforced — but the exported record could misstate
when things happened, which is the product's central claim.

An expired job that was never delivered carries `submittedAt: 0`, and that is verified as the
correct unset value rather than waved through.

## 5b. Two limits the automatic runner does not paper over

- **It refuses unsupported scope rather than revising it.** An earlier version passed
  `reviseScope: true` unconditionally, so asking the one-click runner for an agreement containing
  "make the descriptions persuasive" produced a job whose history claimed an explicit revision that
  nobody had requested. It now throws before anything is created and before any money moves, and
  returns the exact revised pack — by digest — that a caller would have to approve. An approval
  that names a different pack is rejected.
- **Nothing is streamed.** The step list is a log returned when the run completes. The interface
  says "it is a log, not a live feed", and the browser checks are named accordingly. Real progress
  events were not built, because a busy indicator is honest and sufficient here.

## 5e. The interface is designed, and the disclosures are load-bearing

The interface is built on one 12-column grid with a single container width and a single gutter.
Every section — status bar, hero, launch panels, workspace rail and job detail — resolves to that
grid, which is what makes the alignment hold as content changes. Type, spacing and radii come from
one scale each; there are no one-off values.

It follows the system appearance by default and offers a manual light/dark override. Both themes
are first-class; neither is an afterthought with washed-out text.

Three rules constrain the design rather than the other way round:

- **Every disclosure must be legible.** The simulation banner, the "no authority" note under the
  local preview, the "not established by this replay" list and every clause note are measured for
  contrast by `npm run smoke`, which composites alpha properly and fails below WCAG AA 4.5:1. The
  worst measured ratio is currently 5.24:1. A redesign that greyed these out would undermine
  exactly what four rounds of review were about, so it is caught automatically.
- **Nothing animates a result before it is real.** Entrances are short, motion respects
  `prefers-reduced-motion`, and the run log still appears only when the run has finished — the
  interface says "it is a log, not a live feed" rather than implying progress events it does not
  have.
- **The artwork may not imply what the software does not do.** The hero backdrop is deliberately
  not a picture of an AI agent. The status bar two inches above it states that the buyer and
  provider are deterministic programs rather than language models; a robot, an android or a neural
  mesh behind that sentence would re-imply exactly what four review rounds were spent removing, and
  it would be the first thing a reader's eye lands on. What is there instead — two nodes, a link
  between them, a lattice — is derived from the build's own contract-source hash, so it is
  deterministic, unique to this build, and changes only when the contracts do. It is a texture, not
  a diagram to decode, and no claim rests on it.
- **Atmosphere may not cost legibility.** The dark theme uses a radial cast and 2% film grain to
  stop large black fields banding, and luminous edges to suggest depth. None of it sits behind
  text: the grain is fixed at `z-index: -1` beneath the content, and the contrast check runs over
  the composited result, not the intended colour.

## 6. Dependency and toolchain notes

- **OpenZeppelin Contracts 5.4.0** is now a dependency, used for `SafeERC20` and `IERC20`. The
  independent review preferred an established, audited utility to a hand-rolled transfer wrapper,
  and it was right: the hand-rolled one accepted a successful call with empty return data, which is
  exactly what a codeless address produces.
- **Ganache 7.9.2 is unmaintained** and drags in an old dependency tree. `npm audit` reports 37
  advisories (5 critical, 24 high) and essentially all of them come from Ganache's and solc's
  transitive dependencies — old `elliptic`, `pbkdf2`, `sha.js`, `webpack`, `mocha`, and so on.
  These are **local development tooling on a disposable chain bound to loopback**, not code that
  handles value or faces a network. That is a mitigation, not a fix. A production path would move
  to a maintained local EVM.
- One remaining advisory is in `vitest` itself (moderate, path traversal in `@vitest/mocker`) and
  needs a major upgrade to clear. The Vitest UI server is never started here.
- Ganache falls back from native µWS to a JavaScript implementation on this Node build. It prints a
  warning and works. No performance conclusion should be drawn from anything measured here.
- Contracts compile with solc 0.8.37 targeting the **Paris** EVM, because Ganache 7.9.2 tops out at
  Shanghai and Cancun-era opcodes (`MCOPY`) fail on it. This was found by a contract that deployed
  fine and then reverted on its first call.
- `AcceptanceEscrow._termsDigest` splits one 16-field `abi.encode` into two halves purely to stay
  inside the EVM stack limit without via-IR. Every field is a static type, so the concatenation is
  byte-identical to a single call — asserted against the TypeScript single-call encoder in
  `tests/terms-digest.test.ts`, not merely assumed.

## 7. Measured numbers

From `npm run benchmark` (`evidence/benchmark.json`): a fresh disposable chain, three successful
jobs at each size, medians. Instant mining, zero gas price. These are development measurements, not
public-network latency and not a cost in money.

| Path | Records | Txs | Median wall | Median total gas | Funded → settled |
|---|---:|---:|---:|---:|---:|
| baseline (two-step) | 12 | 6 | 1,096 ms | 1,514,194 | 665,805 |
| combined (`submitAndSettle`) | 12 | 5 | 1,263 ms | 1,453,313 (−4.0%) | 604,948 |
| experiment (commitments only) | 12 | 5 | 985 ms | 746,446 (−50.7%) | 297,364 |
| baseline (two-step) | 32 | 6 | 3,533 ms | 3,662,340 | 2,132,312 |
| combined (`submitAndSettle`) | 32 | 5 | 3,947 ms | 3,561,554 (−2.8%) | 2,031,526 |
| experiment (commitments only) | 32 | 5 | 3,435 ms | 1,935,979 (−47.1%) | 1,259,959 |

Re-measured after the payout now verifies the recipient's credit as well as the escrow's debit;
that extra balance read costs about **1,950 gas per settlement** against the previous figures.

Local TypeScript checker: 0.00222 ms/call at 12 records, 0.00658 ms/call at 32 (10,000 calls).
Provider transform: 0.00045 ms and 0.00086 ms. **The checker is slower than the sort it checks**,
which is what you would expect of a fixture chosen to be trivial to perform.

Deployed bytecode: escrow 11,561 bytes, policy 2,859, token 1,649, experiment 8,247.

Reading these honestly:

- `submitAndSettle` saves one transaction and a few percent of gas. Its real benefit is removing
  the window in which valid work sits waiting for someone to ask for settlement; the gas saving is
  incidental and small.
- The wall-clock ordering between baseline and combined is inside the noise of a three-run median
  on an instant-mining chain. Do not read a latency improvement into it.
- The storage experiment roughly halves total gas — but **that saving cannot all be attributed to
  storing fewer rows**, and an earlier version of this document and of the contract's own comment
  said it was "the only difference". That was wrong. The experiment also omits the stored terms
  digest and the `expectedTermsDigest` arguments on acceptance and funding, the policy id/version
  fields, the `createdAt`/`submittedAt`/`settledAt` timestamps, `previewSettlement`,
  `termsDigestOf`, cancellation before funding, and several `createJob` validations. It is not a
  storage-only comparison and it is not behaviourally equivalent. Before it could be promoted it
  would have to regain that behaviour, be tested at parity, and be re-measured.

  It also buys a real cost even on its own terms: the rows must be available off chain or the job
  cannot be settled at all. It does not make the data private — calldata is public — and it does
  not remove the data-availability requirement, it relocates it onto the parties. It is not used by
  the application.
- The baseline figures reproduce the independent review's measurements closely (it recorded
  1,509,437 and 3,657,559 total gas), so the comparison is like for like.
- **Sorting this fixture is cheaper than checking it.** These numbers describe a demonstration
  fixture. They say nothing about whether a reusable acceptance pack amortises on real work.

## 8. Status of the three enforcement claims

| Claim | Status |
|---|---|
| Local contract enforcement | **Demonstrated.** 194 automated tests, 43 browser checks, 7 scenarios and 10 unauthorized actions, all in this repository, including 64 regression tests for four rounds of independent review findings. |
| Standalone public testnet deployment | **Script prepared, not run.** No funded test wallet was authorised. `npm run deploy:testnet` prints the exact prerequisites and deploys nothing without them. |
| Official Virtuals ACP integration | **Not integrated.** Nothing here has ever talked to ACP. See `docs/acp-status.md` for what was verified from pinned source and what blocks it. |
