/**
 * `POST /api/pr-thread-resolve`, both review runtimes: the reviewer's Resolve / Unresolve reaches the forge for the
 * PR under review, and nothing reaches it from a stale tab, for another PR, or for a malformed body.
 *
 * Temp PLANNOTATOR_DATA_DIR per test; every `gh` command goes through a fake runtime.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { SERVER_SESSION_MISMATCH_CODE } from "@plannotator/shared/server-session";
import { setPRCommandRuntimeForTests as setBunPRCommandRuntime } from "./pr";
import { setPRCommandRuntimeForTests as setPiPRCommandRuntime } from "../../apps/pi-extension/server/pr";
import { createFakePRRuntime, type FakePRCommand } from "../../tests/helpers/fake-pr-runtime";

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE"] as const;
const PR_METADATA = {
  platform: "github",
  host: "github.invalid",
  owner: "acme",
  repo: "widgets",
  number: 42,
  title: "Threads",
  author: "someone",
  baseBranch: "main",
  headBranch: "feature",
  baseSha: "base",
  headSha: "head",
  url: "https://github.invalid/acme/widgets/pull/42",
} as const;

let saved: Record<string, string | undefined> | null = null;
const tempDirs: string[] = [];

function sandbox(): void {
  saved ??= Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "plannotator-thread-resolve-"));
  tempDirs.push(dir);
  process.env.PLANNOTATOR_DATA_DIR = dir;
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  delete process.env.PLANNOTATOR_PORT;
}

afterEach(() => {
  setBunPRCommandRuntime(null);
  setPiPRCommandRuntime(null);
  if (saved) {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
    saved = null;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mutationOf = (command: FakePRCommand) =>
  command.args.find((arg) => arg.startsWith("query=mutation"))?.match(/(un)?resolveReviewThread/)?.[0];

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

for (const runtime of ["bun", "pi"] as const) {
  describe(`${runtime} review /api/pr-thread-resolve`, () => {
    async function withServer(
      answer: (command: FakePRCommand) => { stdout: string; stderr: string; exitCode: number } | undefined,
      run: (url: string, nonce: string, mutations: () => string[]) => Promise<void>,
    ) {
      sandbox();
      const fake = createFakePRRuntime(answer);
      (runtime === "bun" ? setBunPRCommandRuntime : setPiPRCommandRuntime)(fake.runtime);
      const options = {
        rawPatch: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
        gitRef: "PR #42",
        htmlContent: "<html></html>",
        prMetadata: PR_METADATA as never,
      };
      const server = runtime === "bun" ? await startBunReviewServer(options) : await startPiReviewServer(options as never);
      try {
        const diff = (await (await fetch(`${server.url}/api/diff`)).json()) as { serverSession: string };
        await run(server.url, diff.serverSession, () => fake.calls.map(mutationOf).filter((m): m is string => !!m));
      } finally {
        await server.stop();
      }
    }

    const resolvedOk = (command: FakePRCommand) =>
      mutationOf(command) ? { stdout: JSON.stringify({ data: { thread: { id: "PRRT_1" } } }), stderr: "", exitCode: 0 } : undefined;

    test("resolves and unresolves the thread on the forge", async () => {
      await withServer(resolvedOk, async (url, nonce, mutations) => {
        const resolve = await post(`${url}/api/pr-thread-resolve`, { threadId: "PRRT_1", resolved: true, prUrl: PR_METADATA.url, serverSession: nonce });
        expect(resolve.status).toBe(200);
        expect(await resolve.json()).toEqual({ ok: true });
        const unresolve = await post(`${url}/api/pr-thread-resolve`, { threadId: "PRRT_1", resolved: false, prUrl: PR_METADATA.url, serverSession: nonce });
        expect(unresolve.status).toBe(200);
        expect(mutations()).toEqual(["resolveReviewThread", "unresolveReviewThread"]);
      });
    });

    test("a stale tab, another PR, or a malformed body reaches nothing", async () => {
      await withServer(resolvedOk, async (url, _nonce, mutations) => {
        const stale = await post(`${url}/api/pr-thread-resolve`, { threadId: "PRRT_1", resolved: true, prUrl: PR_METADATA.url, serverSession: "0".repeat(32) });
        expect(stale.status).toBe(409);
        expect(((await stale.json()) as { code?: string }).code).toBe(SERVER_SESSION_MISMATCH_CODE);
        const otherPR = await post(`${url}/api/pr-thread-resolve`, { threadId: "PRRT_1", resolved: true, prUrl: "https://github.invalid/acme/widgets/pull/41" });
        expect(otherPR.status).toBe(409);
        for (const body of [{}, { threadId: "PRRT_1", resolved: "yes", prUrl: PR_METADATA.url }, { threadId: "", resolved: true, prUrl: PR_METADATA.url }]) {
          expect((await post(`${url}/api/pr-thread-resolve`, body)).status).toBe(400);
        }
        expect(mutations()).toEqual([]);
      });
    });

    test("the forge's refusal comes back as the error", async () => {
      const refused = (command: FakePRCommand) =>
        mutationOf(command) ? { stdout: JSON.stringify({ errors: [{ message: "Resource not accessible by integration" }] }), stderr: "", exitCode: 0 } : undefined;
      await withServer(refused, async (url) => {
        const response = await post(`${url}/api/pr-thread-resolve`, { threadId: "PRRT_1", resolved: true, prUrl: PR_METADATA.url });
        expect(response.status).toBe(502);
        expect(((await response.json()) as { error: string }).error).toContain("Resource not accessible by integration");
      });
    });
  });
}
