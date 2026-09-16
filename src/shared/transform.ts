/**
 * The provider's actual transformation: sort by product ID ascending, prices unchanged.
 *
 * The flaw modes are deliberate defects used to demonstrate a genuine FAIL. They are documented,
 * deterministic, and chosen to reproduce the committed output fixtures exactly for batch 1, so the
 * agent run and the fixture buttons in the interface are demonstrably the same delivery.
 *
 * Kept free of Node dependencies: the browser build runs this same code.
 */
import type { RecordRow } from "./types.ts";
import type { FlawKind } from "./scenarios.ts";

export type { FlawKind };

/**
 * The provider's actual transformation: sort by product ID ascending, prices unchanged.
 *
 * The flaw modes are deliberate defects used to demonstrate a genuine FAIL. They are documented,
 * deterministic, and chosen to reproduce the committed output fixtures exactly for batch 1, so
 * the agent run and the fixture buttons in the interface are demonstrably the same delivery.
 */
export function transform(source: readonly RecordRow[], flaw: FlawKind = "none"): RecordRow[] {
  const sorted = [...source]
    .map((r) => ({ ...r }))
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

  switch (flaw) {
    case "none":
      return sorted;
    case "order": {
      const i = Math.min(4, sorted.length - 2);
      if (i < 0) return sorted;
      const t = sorted[i]!;
      sorted[i] = sorted[i + 1]!;
      sorted[i + 1] = t;
      return sorted;
    }
    case "price": {
      const i = Math.min(8, sorted.length - 1);
      const row = sorted[i]!;
      sorted[i] = { ...row, priceCents: row.priceCents >= 900n ? row.priceCents - 900n : row.priceCents + 900n };
      return sorted;
    }
    case "drop":
      return sorted.filter((_, i) => i !== Math.min(5, sorted.length - 1));
    case "invent": {
      const i = Math.min(2, sorted.length - 1);
      sorted[i] = { productId: 9999n, priceCents: 11111n };
      return sorted.sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
    }
  }
}
