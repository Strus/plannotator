import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGhPRContext } from "./pr-github";
import { setPRThreadResolved } from "./pr-provider";
import { parsePRThreadResolveRequest, type CommandResult, type PRRef, type PRRuntime } from "./pr-types";

const GH: PRRef = { platform: "github", host: "github.com", owner: "o", repo: "r", number: 7 };
const GL: PRRef = { platform: "gitlab", host: "gitlab.example.com", projectPath: "group/sub/proj", iid: 3 };
const BB: PRRef = { platform: "bitbucket", host: "bitbucket.org", workspace: "ws", repo: "repo", number: 5 };

const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", exitCode: 0 });

/** Fake CLI runtime: records every call, answers through `handle`. */
function cli(handle: (args: string[]) => CommandResult): { runtime: PRRuntime; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    runtime: {
      async runCommand(cmd, args) {
        calls.push({ cmd, args });
        return handle(args);
      },
    },
  };
}

const argAfter = (args: string[], flag: string, prefix: string) =>
  args.find((arg, i) => args[i - 1] === flag && arg.startsWith(prefix))?.slice(prefix.length);

describe("resolving a thread on GitHub", () => {
  test("resolve and unresolve run the matching mutation on the thread's node id", async () => {
    const { runtime, calls } = cli(() => ok(JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } })));
    await setPRThreadResolved(runtime, GH, "PRRT_1", true);
    await setPRThreadResolved(runtime, GH, "PRRT_1", false);
    expect(calls.map((c) => c.cmd)).toEqual(["gh", "gh"]);
    expect(argAfter(calls[0]!.args, "-f", "query=")).toContain("resolveReviewThread(input: { threadId: $id })");
    expect(argAfter(calls[1]!.args, "-f", "query=")).toContain("unresolveReviewThread(input: { threadId: $id })");
    expect(calls.every((c) => argAfter(c.args, "-f", "id=") === "PRRT_1")).toBe(true);
  });

  test("a GraphQL refusal on a zero exit still fails with GitHub's words", async () => {
    const { runtime } = cli(() => ok(JSON.stringify({ data: { resolveReviewThread: null }, errors: [{ message: "Resource not accessible by integration" }] })));
    await expect(setPRThreadResolved(runtime, GH, "PRRT_1", true)).rejects.toThrow("Resource not accessible by integration");
  });

  test("a failed gh call fails with its stderr", async () => {
    const { runtime } = cli(() => ({ stdout: "", stderr: "HTTP 401: Bad credentials", exitCode: 1 }));
    await expect(setPRThreadResolved(runtime, GH, "PRRT_1", false)).rejects.toThrow("Couldn't unresolve the thread: HTTP 401: Bad credentials");
  });

  test("the context read carries whether the viewer may resolve each thread", async () => {
    const thread = (id: string, extra: Record<string, unknown>) => ({
      id, isResolved: false, isOutdated: false, line: 3, startLine: null, path: "a.ts", diffSide: "RIGHT", startDiffSide: null,
      comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: `${id}-c`, body: "hi", author: { __typename: "User", login: "ada" }, createdAt: "", url: "" }] },
      ...extra,
    });
    const { runtime } = cli((args) => {
      if (args[0] === "pr") return ok("{}");
      return ok(JSON.stringify({ data: { repository: { pullRequest: {
        comments: { nodes: [] }, reviews: { nodes: [] },
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [
          thread("T_can", { viewerCanResolve: true, viewerCanUnresolve: true }),
          thread("T_cannot", { viewerCanResolve: false, viewerCanUnresolve: false }),
          thread("T_unknown", {}),
        ] },
      } } } }));
    });
    const context = await fetchGhPRContext(runtime, GH as Extract<PRRef, { platform: "github" }>);
    const byId = Object.fromEntries(context.reviewThreads.map((t) => [t.id, [t.viewerCanResolve, t.viewerCanUnresolve]]));
    expect(byId).toEqual({ T_can: [true, true], T_cannot: [false, false], T_unknown: [undefined, undefined] });
  });
});

describe("resolving a thread on GitLab", () => {
  test("PUTs the discussion's resolved flag on the MR, on a self-hosted instance", async () => {
    const { runtime, calls } = cli(() => ok("{}"));
    await setPRThreadResolved(runtime, GL, "abc123", true);
    await setPRThreadResolved(runtime, GL, "abc123", false);
    expect(calls.map((c) => c.args)).toEqual([
      ["api", "projects/group%2Fsub%2Fproj/merge_requests/3/discussions/abc123?resolved=true", "--method", "PUT", "--hostname", "gitlab.example.com"],
      ["api", "projects/group%2Fsub%2Fproj/merge_requests/3/discussions/abc123?resolved=false", "--method", "PUT", "--hostname", "gitlab.example.com"],
    ]);
    expect(calls.every((c) => c.cmd === "glab")).toBe(true);
  });

  test("a refusal fails with glab's words", async () => {
    const { runtime } = cli(() => ({ stdout: "", stderr: "403 Forbidden", exitCode: 1 }));
    await expect(setPRThreadResolved(runtime, GL, "abc123", true)).rejects.toThrow("Couldn't resolve the thread: 403 Forbidden");
  });
});

describe("resolving a thread on Bitbucket", () => {
  const ENV = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_BITBUCKET_API_URL", "PLANNOTATOR_BITBUCKET_TOKEN", "PLANNOTATOR_BITBUCKET_EMAIL"] as const;
  let saved: Record<string, string | undefined>;
  let dataDir: string;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    dataDir = mkdtempSync(join(tmpdir(), "plannotator-bb-resolve-"));
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    process.env.PLANNOTATOR_BITBUCKET_API_URL = "https://api.bitbucket.invalid/2.0";
    process.env.PLANNOTATOR_BITBUCKET_TOKEN = "fake-token";
    delete process.env.PLANNOTATOR_BITBUCKET_EMAIL;
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  function bitbucket(status: number, body = "{}") {
    const requests: { method: string; url: string; auth: string | null }[] = [];
    const runtime: PRRuntime = {
      async runCommand() {
        throw new Error("Bitbucket must not shell out to a CLI");
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ method: init?.method ?? "GET", url: String(input), auth: new Headers(init?.headers).get("authorization") });
        return new Response(body, { status, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    };
    return { runtime, requests };
  }

  test("POST resolves and DELETE reopens the root comment's thread", async () => {
    const { runtime, requests } = bitbucket(200);
    await setPRThreadResolved(runtime, BB, "42", true);
    await setPRThreadResolved(runtime, BB, "42", false);
    const url = "https://api.bitbucket.invalid/2.0/repositories/ws/repo/pullrequests/5/comments/42/resolve";
    expect(requests).toEqual([
      { method: "POST", url, auth: "Bearer fake-token" },
      { method: "DELETE", url, auth: "Bearer fake-token" },
    ]);
  });

  test("a refusal fails with Bitbucket's words", async () => {
    const { runtime } = bitbucket(403, JSON.stringify({ error: { message: "You may not resolve this comment" } }));
    await expect(setPRThreadResolved(runtime, BB, "42", true)).rejects.toThrow("You may not resolve this comment");
  });
});

describe("parsePRThreadResolveRequest", () => {
  test("takes a thread id, a boolean and the PR url, and refuses anything else", () => {
    expect(parsePRThreadResolveRequest({ threadId: "T1", resolved: false, prUrl: "u", serverSession: "s" })).toEqual({ threadId: "T1", resolved: false, prUrl: "u" });
    for (const bad of [null, "x", {}, { threadId: "", resolved: true, prUrl: "u" }, { threadId: "T1", resolved: "true", prUrl: "u" }, { threadId: "T1", resolved: true }, { threadId: "x".repeat(257), resolved: true, prUrl: "u" }]) {
      expect(parsePRThreadResolveRequest(bad)).toBeNull();
    }
  });
});
