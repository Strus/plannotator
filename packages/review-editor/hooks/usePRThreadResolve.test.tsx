/**
 * DOM-gated (DOM_TESTS=1): resolving a PR thread from the diff. What regresses: the click waiting on the forge before
 * the thread changes; a refusal leaving the thread shown resolved (or folded away) with no word why; a double click
 * sending two opposite writes; the reviewer's own resolve sticking after someone unresolves the thread on the forge.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PRContext, PRReviewThread } from '@plannotator/shared/pr-types';
import { usePRThreadResolve, type PRThreadResolveState } from './usePRThreadResolve';
import { PRLineThread, PRThreadMemory } from '../components/PRLineThread';

const hasDom = typeof document !== 'undefined';
const PR_URL = 'https://github.com/o/r/pull/1';

const thread = (isResolved: boolean): PRReviewThread => ({
  id: 'T1', isResolved, isOutdated: false, path: 'a.ts', line: 3, startLine: null, diffSide: 'RIGHT',
  comments: [{ id: 'c1', author: 'mona', body: 'Rename this?', createdAt: '2026-11-01T00:00:00Z', url: `${PR_URL}#discussion_c1` }],
});

const context = (isResolved: boolean): PRContext => ({
  body: '', state: 'OPEN', isDraft: false, labels: [], reviewDecision: '', mergeable: '', mergeStateStatus: '',
  comments: [], reviews: [], reviewThreads: [thread(isResolved)], checks: [], linkedIssues: [],
});

interface Pending { body: unknown; answer: (status: number, body: unknown) => void }

function fakeForge() {
  const requests: Pending[] = [];
  const fetchImpl = ((_url: string, init: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({
      body: JSON.parse(String(init.body)),
      answer: (status, body) => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
    });
  })) as typeof fetch;
  return { requests, fetchImpl };
}

function Harness({ raw, fetchImpl, errors, out, memory }: {
  raw: PRContext;
  fetchImpl: typeof fetch;
  errors: string[];
  out: { current: PRThreadResolveState | null };
  memory: PRThreadMemory;
}) {
  const state = usePRThreadResolve(raw, PR_URL, (message) => errors.push(message), fetchImpl);
  out.current = state;
  const shown = state.prContext!.reviewThreads[0]!;
  return (
    <PRLineThread
      placed={{ thread: shown, filePath: 'a.ts', line: 3, side: 'new', where: 'line' }}
      memory={memory}
      forge="GitHub"
      authenticatedImages={false}
      onSetResolved={state.setThreadResolved}
      busy={state.busy}
    />
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(raw: PRContext) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const forge = fakeForge();
  const errors: string[] = [];
  const out: { current: PRThreadResolveState | null } = { current: null };
  const memory = new PRThreadMemory();
  const render = (next: PRContext) => root!.render(<Harness raw={next} fetchImpl={forge.fetchImpl} errors={errors} out={out} memory={memory} />);
  await act(async () => {
    root = createRoot(host!);
    render(raw);
  });
  return {
    ...forge,
    errors,
    api: out,
    rerender: (next: PRContext) => act(async () => render(next)),
    card: () => host!.querySelector('[data-pr-thread="T1"]')!,
    click: (what: 'resolve' | 'unresolve') => act(async () => {
      (host!.querySelector(`[data-pr-thread-resolve="${what}"]`) as HTMLButtonElement).click();
    }),
    answer: (status: number, body: unknown) => act(async () => {
      forge.requests.at(-1)!.answer(status, body);
      await new Promise((r) => setTimeout(r, 0));
    }),
  };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe.if(hasDom)('resolving a PR thread from the diff', () => {
  test('the thread folds as resolved at once; a refusal opens it again and says why', async () => {
    const view = await mount(context(false));
    expect(view.card().hasAttribute('data-open')).toBe(true);

    await view.click('resolve');
    expect(view.requests.map((r) => r.body)).toEqual([{ threadId: 'T1', resolved: true, prUrl: PR_URL }]);
    expect(view.card().hasAttribute('data-pr-thread-resolved')).toBe(true);
    expect(view.card().hasAttribute('data-open')).toBe(false);

    // A second toggle before the forge answers sends nothing.
    await act(async () => view.api.current!.setThreadResolved('T1', false));
    expect(view.requests).toHaveLength(1);

    await view.answer(502, { error: "Couldn't resolve the thread: Resource not accessible by integration" });
    expect(view.card().hasAttribute('data-pr-thread-resolved')).toBe(false);
    expect(view.card().hasAttribute('data-open')).toBe(true);
    expect(view.errors).toEqual(["Couldn't resolve the thread: Resource not accessible by integration"]);
  });

  test('a resolve the forge took holds until its read shows it, then the forge decides again', async () => {
    const view = await mount(context(false));
    await view.click('resolve');
    await view.answer(200, { ok: true });
    expect(view.errors).toEqual([]);

    // A poll that left before the write still says unresolved: the reviewer's resolve stays shown.
    await view.rerender(context(false));
    expect(view.card().hasAttribute('data-pr-thread-resolved')).toBe(true);

    await view.rerender(context(true));
    expect(view.card().hasAttribute('data-pr-thread-resolved')).toBe(true);

    // Someone unresolves it on GitHub afterwards: that shows.
    await view.rerender(context(false));
    expect(view.card().hasAttribute('data-pr-thread-resolved')).toBe(false);
  });

  test('unresolving keeps the thread open', async () => {
    const view = await mount(context(true));
    await act(async () => (view.card() as HTMLButtonElement).click());
    expect(view.card().hasAttribute('data-open')).toBe(true);
    await view.click('unresolve');
    expect(view.requests.map((r) => r.body)).toEqual([{ threadId: 'T1', resolved: false, prUrl: PR_URL }]);
    expect(view.card().hasAttribute('data-open')).toBe(true);
    expect(view.card().hasAttribute('data-pr-thread-resolved')).toBe(false);
  });
});
