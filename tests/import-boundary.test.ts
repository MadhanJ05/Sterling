import { describe, it, expect } from "vitest";
import { importRecordsFromJson, exportRecordsToJson } from "../src/shared/importJson.ts";
import { fixtureText, loadExpectations, loadFixture } from "../src/chain/fixtures.ts";

const expectations = loadExpectations();

describe("JSON import boundary", () => {
  for (const c of expectations.importBoundary) {
    it(`rejects ${c.file} with ${c.code} — ${c.why}`, () => {
      const res = importRecordsFromJson(fixtureText(c.file));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.issues.map((i) => i.code)).toContain(c.code);
      for (const issue of res.issues) expect(issue.message.length).toBeGreaterThan(10);
    });
  }

  it("accepts every good fixture", () => {
    for (const f of ["source-batch-1.json", "output-correct.json", "source-batch-3.json"]) {
      const res = importRecordsFromJson(fixtureText(f));
      expect(res.ok, `${f} should import`).toBe(true);
    }
  });

  it("round-trips export -> import without change", () => {
    const rows = loadFixture("source-batch-1.json");
    const again = importRecordsFromJson(exportRecordsToJson(rows));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.rows).toEqual(rows);
  });

  it("refuses to export a value JSON cannot hold exactly", () => {
    expect(() => exportRecordsToJson([{ productId: 1n, priceCents: 2n ** 60n }])).toThrow(/safe-integer/);
  });

  it("reports every problem in one pass rather than only the first", () => {
    const res = importRecordsFromJson(
      JSON.stringify([{ productId: 1.5, priceCents: "x", extra: 1 }, { priceCents: 5 }]),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const codes = res.issues.map((i) => i.code);
    expect(codes).toContain("UNKNOWN_FIELD");
    expect(codes).toContain("ID_NOT_INTEGER");
    expect(codes).toContain("PRICE_NOT_NUMBER");
    expect(codes).toContain("ID_MISSING");
  });

  it("never silently keeps a subset of rows when something is wrong", () => {
    const res = importRecordsFromJson(JSON.stringify([{ productId: 1, priceCents: 1 }, { productId: 2 }]));
    expect(res.ok).toBe(false);
  });

  it("rejects a non-array root and an empty array", () => {
    expect(importRecordsFromJson('{"productId":1,"priceCents":2}').ok).toBe(false);
    expect(importRecordsFromJson("[]").ok).toBe(false);
  });
});
