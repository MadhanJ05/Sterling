/**
 * Browser-side fixture access. The same committed JSON the Node side reads from disk.
 *
 * Loaded as raw text, not parsed JSON: some fixtures are deliberately malformed because they exist
 * to be rejected by the import boundary, and every fixture must go through that boundary here
 * exactly as it does on the Node side.
 */
import { importRecordsFromJson } from "../shared/importJson.ts";
import type { RecordRow } from "../shared/types.ts";

const files = import.meta.glob("../../fixtures/*.json", {
  eager: true, query: "?raw", import: "default",
}) as Record<string, string>;

const byName: Record<string, string> = {};
for (const [path, text] of Object.entries(files)) byName[path.split("/").pop()!] = text;

export function fixtureText(name: string): string {
  const text = byName[name];
  if (text === undefined) throw new Error(`No fixture ${name}`);
  return text;
}

/** Goes through the same strict import boundary the Node side uses. */
export function loadFixture(name: string): RecordRow[] {
  const res = importRecordsFromJson(fixtureText(name));
  if (!res.ok) {
    throw new Error(`Fixture ${name} failed import: ${res.issues.map((i) => `${i.code} ${i.message}`).join("; ")}`);
  }
  return res.rows;
}
