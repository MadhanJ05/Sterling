import { describe, it, expect } from "vitest";
import { check, evaluate } from "../src/shared/policy.ts";
import { loadExpectations, loadFixture } from "../src/chain/fixtures.ts";
import { Verdict } from "../src/shared/types.ts";

const expectations = loadExpectations();
const source = loadFixture(expectations.source);

describe("local checker against the hand-written expectations", () => {
  for (const c of expectations.cases) {
    it(`${c.output}: ${c.verdict}${c.ruleId ? ` on rule ${c.ruleId}` : ""}`, () => {
      const output = loadFixture(c.output);
      const r = evaluate(source, output, expectations.requiredRowCount);
      expect(r.verdictName, c.why).toBe(c.verdict);
      expect(r.ruleId).toBe(c.ruleId);
      expect(r.failCode).toBe(c.failCode);
      if (c.detailA !== undefined) expect(r.detailA).toBe(BigInt(c.detailA));
      if (c.detailB !== undefined) expect(r.detailB).toBe(BigInt(c.detailB));
    });
  }

  it("produces a readable finding per rule, and marks later rules as not reached", () => {
    const report = check(source, loadFixture("output-wrong-price.json"), 12);
    expect(report.findings).toHaveLength(4);
    expect(report.findings[0]!.status).toBe("PASS");
    expect(report.findings[1]!.status).toBe("PASS");
    expect(report.findings[2]!.status).toBe("FAIL");
    expect(report.findings[2]!.detail).toContain("3499.00");
    expect(report.findings[2]!.detail).toContain("3490.00");
    expect(report.findings[3]!.status).toBe("NOT_REACHED");
    expect(report.headline).toMatch(/Rule 3/);
  });

  it("supports template reuse across three batches with different ids and prices", () => {
    for (const t of [
      { s: "source-batch-1.json", o: "output-correct.json", n: 12 },
      ...expectations.templateReuse.map((x: any) => ({ s: x.source, o: x.output, n: x.requiredRowCount })),
    ]) {
      const r = evaluate(loadFixture(t.s), loadFixture(t.o), t.n);
      expect(r.verdictName, `${t.s} -> ${t.o}`).toBe("PASS");
    }
  });

  it("does not assume the source is sorted", () => {
    // batch 3's source is stored in descending order; the correct output is still ascending.
    const r = evaluate(loadFixture("source-batch-3.json"), loadFixture("output-batch-3-correct.json"), 20);
    expect(r.verdictName).toBe("PASS");
  });

  it("returns INDETERMINATE rather than a verdict when it cannot evaluate", () => {
    expect(evaluate([], [], 0).verdict).toBe(Verdict.INDETERMINATE);
    expect(evaluate(source, [], 12, 0x07).verdict).toBe(Verdict.INDETERMINATE);
    expect(evaluate(source, [], 99).verdict).toBe(Verdict.INDETERMINATE);
    const tooMany = Array.from({ length: 33 }, (_, i) => ({ productId: BigInt(i), priceCents: 1n }));
    expect(evaluate(tooMany, tooMany, 33).verdict).toBe(Verdict.INDETERMINATE);
  });

  it("an empty delivery against a real source is a rule 1 failure, not indeterminate", () => {
    const r = evaluate(source, [], 12);
    expect(r.verdictName).toBe("FAIL");
    expect(r.ruleId).toBe(1);
  });
});
