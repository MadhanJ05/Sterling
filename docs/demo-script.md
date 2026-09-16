# Presenter script — five minutes

Before you start: `npm start`, open `http://127.0.0.1:5173`, and leave the terminal visible.
Everything below is a live click-through. Nothing is pre-recorded.

---

## 0 · Frame it (20 seconds)

> "One AI hires another to prepare a data file. Before work starts they approve a checklist of what
> counts as done. The buyer sets aside payment. The provider submits. Software checks it, and the
> payment contract follows the approved rules.
>
> Everything you're about to see is a local simulation. Synthetic data, test tokens worth nothing,
> and I control every participant. That banner stays up the whole time."

Point at the banner. Do not skip this.

## 1 · The conforming case (60 seconds)

Click **Run a job that satisfies the checklist**. A busy indicator runs; the step list appears when
it finishes. (It is a log, not a live feed — the interface says so rather than implying progress
events it does not have.)

> "One click. The buyer proposed an agreement, the provider re-derived it from the contract and
> accepted, the buyer funded the escrow, and the provider delivered. Checking and payment happened
> in the same transaction — there's no gap where finished work sits waiting for someone to ask for
> settlement.
>
> Twenty-five test dollars moved from buyer to provider, on the contract's own evaluation."

Click **Inspect each step**.

> "Step one, the job: a buyer, a provider, twelve products, twenty-five test dollars.
>
> Step two is the part that matters. Four clauses in plain language, and next to each one a badge
> saying which executable rule it maps to. Four of four are checkable. That is the coverage report,
> and it is the thing we would actually sell."

> "And the provider didn't take the buyer's word for any of it. Before accepting, it re-derived the
> whole agreement from what the contract actually stored — the amount, the source batch, the token
> address, the deadlines, every clause — and would have refused on any disagreement. Matching
> fingerprints aren't enough: a pack can hash exactly as advertised and still describe a different
> sum of money.
>
> Note the wording under the findings: this preview has no authority. It's the same rules computed
> here for display. The money moved on the contract's own evaluation."

## 2 · The case that earns the product (75 seconds)

Click **Run one that does not**.

> "Look at the delivery. Twelve rows, every product present, every price exactly right. The only
> thing wrong is that two products are out of order — and the parties agreed that sorting matters.
>
> This is the case a busy human reviewer waves straight through. It's also the case an evaluator
> asked to judge freely is least consistent on, because it *feels* fine. The check doesn't care how
> it feels."

Click **Inspect each step** and point at the red row 1005.

> "Rule four, named, with the specific products. Refunded to the buyer. Both jobs are still on the
> left with different outcomes — one job never reaches two states."

## 3 · The clause we refuse to fake (60 seconds)

Open **Advanced demonstration**, then click **A clause software cannot check**.

> "The pack says 'make the product descriptions persuasive.' The contract refused to create the
> job.
>
> There is no committed predicate for 'persuasive.' Two competent reviewers can read the same bytes
> and disagree. So the coverage report marks it as requiring judgement, and that blocks the
> automatic flow entirely.
>
> Read that line: *there is no button that quietly deletes the clause.* The only way forward is an
> explicit scope revision."

> "And there is no automatic path that does this for you either. The one-click runner refuses an
> unsupported agreement outright — nothing created, nothing funded — and hands back the exact
> revised pack you would be approving, by digest."

Click **Approve that revised pack and create the job**.

> "Version two of the pack. The clause is still there, marked excluded, with the reason attached.
> Both parties can see exactly what the payment no longer depends on. That honesty is the product.
> A tool that silently dropped it would be worse than useless — it would be a liability."

## 4 · Try to break it (60 seconds)

Still in **Advanced demonstration**, click **The deployer tries to force a verdict or move the
escrow**.

> "I deployed these contracts. There is no owner function, no admin, no pause, no upgrade path and
> no withdrawal. I can request settlement, and I get the same answer as anyone else.
>
> This isn't a screenshot — it just sent the transaction and recorded what happened."

Click one or two more: **Provider submits a second, better delivery**, **Settlement is requested
after expiry**.

> "One submission per funded job. And after expiry the contract *cannot pay*, even for conforming
> work — the refund path is all that's left. That's a timeout rule, not a judgement about the work,
> and the interface says so rather than letting you assume the delivery was bad."

## 5 · Reuse, the two programs, and the receipt (60 seconds)

Back at the top, paste a few rows into **Use your own batch** and click **Import and reuse the
template**.

> "Same four rules, same template, a batch it has never seen. That's what reuse looks like — and
> the box says plainly that only this one template is supported. We're not advertising a
> general-purpose acceptance editor we don't have."

Under **Run the two demo programs**, click **fail-order**. The log appears when the run finishes.

> "Those are two real operating-system processes with separate keys, talking only through the
> chain. They're deterministic programs, not language models — no API key, no model call. And I
> started both of them, which is why that's written on the panel."

Click **Export and verify an evidence bundle**.

> "Three questions, three separate answers, deliberately not merged. The rules reproduce. The
> bundle is internally consistent — every number it shows a human agrees with the terms it carries,
> which matters because rewriting a display field is the cheapest possible forgery.
>
> And the third one says **not checked**. Replaying a file does not prove a payment happened; a
> bundle is a file and anyone can write one. To establish payment you run the verifier with
> `--rpc`, and then it checks the chain, the deployed contracts, the escrow's own event for this
> job, and a token transfer of the exact amount to the exact recipient. Until you do that, it will
> not tell you it verified anything."

## Close (20 seconds)

> "What this demonstrates is mechanism: agreement, commitment, enforcement, and an honest coverage
> report. What it does not demonstrate is demand. Nobody has been interviewed and no loss has been
> measured, on purpose.
>
> And the open question I'd rather raise than have you find: whether writing the answer key costs
> less than doing the work. This fixture is trivial by design, so it can't tell us. Testing that on
> a real recurring deliverable is the next thing worth doing."

---

## If something goes wrong

- The whole thing runs offline. If a click hangs, Ctrl+C and `npm start` again — you lose the
  session's jobs, and nothing else.
- `npm run demo` runs every scenario headlessly in about 40 seconds if the UI misbehaves. It uses
  its own isolated session, so it is safe to run while the app is open.
- Screenshots of every step are in `evidence/screenshots/`, regenerated by `npm run smoke`.

## Questions you should expect

**"How is this different from just writing a test suite?"**
The rules are agreed and fingerprinted *before* work starts, by both parties, and the payment
follows them without either side deciding. A test suite the buyer runs after delivery is the buyer
judging its own case.

**"What stops the buyer writing impossible rules?"**
Nothing in the software, and it shouldn't. The provider reads the pack and the coverage report
before accepting, and refuses. What the software guarantees is that the rules cannot change after
acceptance.

**"Why blockchain?"**
The honest version: escrow and timestamps alone would not justify it. What does the work here is
that the release decision is computed by a contract neither party controls, from data neither party
can substitute afterwards. Whether that clears the bar is a fair thing to argue about.

**"Why is checking and paying one transaction?"**
Because this checker is small, synchronous and bounded at 32 rows, so there is no reason for
finished work to wait. It grants nothing new: the caller supplies rows, never a verdict. If the
checker cannot complete, the whole transaction reverts and nothing is recorded — the provider
retries, or the escrow expires back to the buyer. We did not add an override.

**"Is the evaluator an LLM?"**
No. The default demo makes no model calls and needs no API key. That is the point: the rules that
move money are executable, not judged.
