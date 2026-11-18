/**
 * In PR Overview, `J` opens the first file of the left panel's list with the
 * line cursor on its first line (DOM_TESTS=1, lineCursor.ts).
 *
 * Failures caught: J doing nothing on the overview, opening a file other than
 * the first one the tree lists (the files array order is not the tree's), and
 * the file opening with no line highlighted, so the next J has nowhere to go
 * from.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";
import { configStore } from "@plannotator/ui/config";

// Vite-only virtual module (`?worker&inline`), stubbed like App.panelView.test.tsx.
mock.module("./workerPool", () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== "undefined";

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

// The patch lists src/zeta.ts first; the tree (folders first, then by name)
// lists lib/alpha.ts first.
const PATCH = [
  "diff --git a/src/zeta.ts b/src/zeta.ts",
  "index 0000001..0000002 100644",
  "--- a/src/zeta.ts",
  "+++ b/src/zeta.ts",
  "@@ -1 +1 @@",
  "-z",
  "+Z",
  "diff --git a/lib/alpha.ts b/lib/alpha.ts",
  "index 0000003..0000004 100644",
  "--- a/lib/alpha.ts",
  "+++ b/lib/alpha.ts",
  "@@ -1,2 +1,2 @@",
  " const keep = 1;",
  "-const a = 1;",
  "+const a = 2;",
  "",
].join("\n");

const PR_METADATA = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "parser",
  number: 7,
  title: "Parser rework",
  author: "someone-else",
  baseBranch: "main",
  headBranch: "feature/parser",
  baseSha: "1111111111111111111111111111111111111111",
  headSha: "2222222222222222222222222222222222222222",
  url: "https://github.com/acme/parser/pull/7",
};

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

function makeFetch(): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init).
  const impl = async (input: RequestInfo | URL) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/diff") {
      return Response.json({
        rawPatch: PATCH,
        gitRef: "HEAD",
        snapshotId: "snap-1",
        origin: "claude-code",
        diffType: "uncommitted",
        hideWhitespace: false,
        prMetadata: PR_METADATA,
        serverConfig: {},
      });
    }
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname === "/api/file-content") return Response.json({ oldContent: null, newContent: null });
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(check: () => boolean, label: string, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

function seedAnnouncementsSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-announce-ask-session-seen", "1");
  memory.set("plannotator-announce-agent-tool-seen", "1");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-token-hover-announcement-seen", "1");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

/** Every element under `node`, shadow roots included. */
function everyElement(node: ParentNode, out: Element[] = []): Element[] {
  for (const el of node.querySelectorAll("*")) {
    out.push(el);
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) everyElement(shadow, out);
  }
  return out;
}

const activeTab = () => document.querySelector('[data-pane-tab][aria-selected="true"]')?.textContent?.trim() ?? "";
const selectedRows = () =>
  everyElement(document).filter((el) => el.hasAttribute("data-selected-line") && el.hasAttribute("data-line-type"));

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("PR Overview: J", () => {
  test("opens the tree's first file with the cursor on its first line", async () => {
    seedAnnouncementsSeen();
    setStorageBackend(memoryBackend);
    configStore.loadFromBackend();
    globalThis.fetch = makeFetch();
    // SAFETY: the App only uses EventSource's constructor, handlers, and close.
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<App />);
    });
    await waitFor(() => activeTab().includes("PR Overview"), "the PR Overview tab");
    await settle(5);

    const event = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
    await act(async () => {
      document.body.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);

    await waitFor(() => activeTab().includes("alpha.ts"), "lib/alpha.ts to open");
    await waitFor(() => selectedRows().length > 0, "a highlighted line");
    // The first row of lib/alpha.ts: unified row 0, the context line 1.
    const rows = selectedRows();
    expect(new Set(rows.map((el) => el.getAttribute("data-line-index")?.split(",")[0]))).toEqual(new Set(["0"]));
  });
});
