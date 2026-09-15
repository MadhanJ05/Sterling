import { describe, it, expect } from "vitest";
import {
  buildPack, canonicalPackJson, coverage, packDigest, rebindToSource, reviseScope, SUBJECTIVE_CLAUSE,
} from "../src/shared/pack.ts";
import { loadFixture } from "../src/chain/fixtures.ts";
import { payment } from "./helpers.ts";

const source = loadFixture("source-batch-1.json");

describe("acceptance pack and coverage report", () => {
  it("marks all four clauses executable for the supported job", () => {
    const cov = coverage(buildPack({ title: "t", source, payment: payment() }));
    expect(cov.executable).toBe(4);
    expect(cov.unsupportedClauseCount).toBe(0);
    expect(cov.fullyAutomatic).toBe(true);
  });

  it("refuses to call the subjective clause automatically checkable", () => {
    const pack = buildPack({ title: "t", source, payment: payment(), includeSubjectiveClause: true });
    const cov = coverage(pack);
    expect(cov.judgement).toBe(1);
    expect(cov.fullyAutomatic).toBe(false);
    expect(cov.summary).toMatch(/cannot enter the automatic flow/);
    expect(pack.clauses.map((c) => c.text)).toContain(SUBJECTIVE_CLAUSE.text);
  });

  it("scope revision keeps the clause visible and bumps the pack version", () => {
    const v1 = buildPack({ title: "t", source, payment: payment(), includeSubjectiveClause: true });
    const v2 = reviseScope(v1, "C5", "Descriptions will be reviewed by a human outside this contract.");
    expect(v2.packVersion).toBe(2);
    expect(v2.clauses).toHaveLength(v1.clauses.length);
    const c5 = v2.clauses.find((c) => c.id === "C5")!;
    expect(c5.coverage).toBe("EXCLUDED_BY_REVISION");
    expect(c5.text).toBe(SUBJECTIVE_CLAUSE.text);
    expect(c5.note).toMatch(/Reason: Descriptions will be reviewed/);
    expect(coverage(v2).fullyAutomatic).toBe(true);
    expect(coverage(v2).excludedByRevision).toBe(1);
    expect(v2.revisionHistory[0]).toMatch(/C5 excluded by revision/);
    // The original object is untouched: a revision cannot reach back into an existing job.
    expect(v1.packVersion).toBe(1);
    expect(coverage(v1).fullyAutomatic).toBe(false);
  });

  it("refuses to revise away an executable clause", () => {
    const v1 = buildPack({ title: "t", source, payment: payment() });
    expect(() => reviseScope(v1, "C1", "inconvenient")).toThrow(/executable/);
  });

  it("the digest changes when anything material changes, and only then", () => {
    const a = buildPack({ title: "t", source, payment: payment() });
    const again = buildPack({ title: "t", source, payment: payment() });
    expect(packDigest(a)).toBe(packDigest(again));

    expect(packDigest(buildPack({ title: "t", source, payment: payment(999n) }))).not.toBe(packDigest(a));
    expect(packDigest(buildPack({ title: "other", source, payment: payment() }))).not.toBe(packDigest(a));
    expect(packDigest(buildPack({ title: "t", source: loadFixture("source-batch-2.json"), payment: payment() })))
      .not.toBe(packDigest(a));
    expect(packDigest(reviseScope(
      buildPack({ title: "t", source, payment: payment(), includeSubjectiveClause: true }), "C5", "r",
    ))).not.toBe(packDigest(a));
  });

  it("canonical JSON has a fixed key order regardless of object construction", () => {
    const a = buildPack({ title: "t", source, payment: payment() });
    const { payment: pay, title, ...rest } = a;
    const shuffled = JSON.parse(JSON.stringify({ payment: pay, title, ...rest })) as typeof a;
    expect(canonicalPackJson(shuffled)).toBe(canonicalPackJson(a));
  });

  it("rebinding the template to another batch keeps the rules and changes the source binding", () => {
    const a = buildPack({ title: "January", source, payment: payment() });
    const b2 = loadFixture("source-batch-2.json");
    const b = rebindToSource(a, b2, "February");
    expect(b.requiredRowCount).toBe(8);
    expect(b.clauses[0]!.text).toMatch(/exactly 8 rows/);
    expect(b.clauses.map((c) => c.ruleId)).toEqual(a.clauses.map((c) => c.ruleId));
    expect(b.sourceDigest).not.toBe(a.sourceDigest);
    expect(packDigest(b)).not.toBe(packDigest(a));
  });
});
