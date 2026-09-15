/** Node-side fixture loading. Everything goes through the strict import boundary. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importRecordsFromJson } from "../shared/importJson.ts";
import type { RecordRow } from "../shared/types.ts";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES_DIR = join(PROJECT_ROOT, "fixtures");

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

/** Loads a fixture through importRecordsFromJson; a bad fixture is a loud failure, never a guess. */
export function loadFixture(name: string): RecordRow[] {
  const res = importRecordsFromJson(fixtureText(name));
  if (!res.ok) {
    throw new Error(`Fixture ${name} failed import: ${res.issues.map((i) => `${i.code} ${i.message}`).join("; ")}`);
  }
  return res.rows;
}

export function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort();
}

export function loadExpectations(): any {
  return JSON.parse(fixtureText("expectations.json"));
}

export function loadGoldenVectors(): any {
  return JSON.parse(fixtureText("golden-vectors.json"));
}
