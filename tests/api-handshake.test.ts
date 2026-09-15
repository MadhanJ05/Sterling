/**
 * The page and the server process must agree about which API they are speaking.
 *
 * A session left open across a route change produced a new page calling an old server, an HTML 404,
 * and an unreadable parse error at the moment a button was pressed. These tests keep the handshake
 * wired up and keep the failure legible if it ever happens again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/chain/fixtures.ts";
import { API_VERSION } from "../src/shared/apiVersion.ts";

describe("API handshake between page and server", () => {
  it("the server reports its API version on /api/state", () => {
    const server = readFileSync(join(PROJECT_ROOT, "src/server/index.ts"), "utf8");
    expect(server).toContain("apiVersion: API_VERSION");
    expect(server).toContain('from "../shared/apiVersion.ts"');
  });

  it("the page compares it and says what to do", () => {
    const app = readFileSync(join(PROJECT_ROOT, "src/web/App.tsx"), "utf8");
    expect(app).toContain("API_VERSION");
    expect(app).toContain("older than this page");
    expect(app).toMatch(/npm start/);
  });

  it("the version is a concrete string, not a placeholder", () => {
    expect(API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("a non-JSON error response tells the operator to restart rather than reporting a parse failure", () => {
    const api = readFileSync(join(PROJECT_ROOT, "src/web/api.ts"), "utf8");
    // The old text said only "The server returned something that is not JSON", twice over.
    expect(api).not.toContain("returned something that is not JSON");
    expect(api).toContain("older than the page");
    expect(api).toMatch(/npm start/);
  });
});

describe("starting a second server on a taken port", () => {
  /**
   * An orphaned server holding the port is what produced the original confusion: the old process
   * kept answering, the page loaded from disk against its stale routes, and the only symptom was a
   * parse error when a button was pressed. Starting must fail immediately and say so.
   */
  it("refuses immediately, exits non-zero, and says how to clear it", async () => {
    const port = 5291;
    const holder = createServer();
    await new Promise<void>((res) => holder.listen(port, "127.0.0.1", () => res()));

    try {
      const started = Date.now();
      const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        const p = spawn(
          process.execPath,
          [join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs"), join(PROJECT_ROOT, "src/server/index.ts")],
          { cwd: PROJECT_ROOT, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        p.stdout.on("data", (d) => { out += d; });
        p.stderr.on("data", (d) => { out += d; });
        p.on("error", reject);
        p.on("close", (code) => resolve({ code, out }));
      });
      const elapsed = Date.now() - started;

      expect(result.code, result.out).toBe(1);
      expect(result.out).toMatch(/already in use/);
      expect(result.out).toMatch(/lsof -nP -iTCP:5291/);
      expect(result.out).toMatch(/PORT=\d+ npm start/);
      // It must not claim to be listening before failing, and must not spend time deploying first.
      expect(result.out).not.toMatch(/Open\s+http/);
      expect(elapsed).toBeLessThan(12_000);
    } finally {
      await new Promise<void>((res) => holder.close(() => res()));
    }
  }, 60_000);
});
