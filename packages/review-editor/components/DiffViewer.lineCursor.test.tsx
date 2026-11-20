/**
 * `J` / `K` move a line cursor through the open file's lines and comments,
 * `I` / `Enter` comment on it (lineCursor.ts).
 *
 * Rendered with the REAL @pierre/diffs: the cursor finds rows by the
 * `data-line-index` Pierre writes. happy-dom has no layout, so each row is
 * placed by its unified index (ROW px a row).
 *
 * Guards: J skipping a line or a comment, a comment visited before its line,
 * the highlight left on a line while a comment is selected (or the other way
 * round), K not walking back the same way, the last line not handing over to
 * the next file (and the first to the previous), a file entered from the
 * previous one not landing on its first or last line, `I` opening the
 * composer on the wrong lines or `Enter` on a comment not editing that
 * comment, `Ctrl+D` / `Ctrl+U` not moving by half the view or running past
 * a file's edge, the keys acting while the panel is not active or while
 * the composer is open, and the cursor line left at the light tint of a line
 * selected by hand (so it can hardly be seen).
 *
 * DOM-gated (DOM_TESTS=1) and run by .github/workflows/test.yml's
 * "Run diff-renderer DOM tests (isolated, real @pierre/diffs)" step.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useImperativeHandle, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation, SelectedLineRange } from '@plannotator/ui/types';

const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  buildLineBgOverrides: () => '',
  resolveSyntaxTheme: realResolveSyntaxTheme,
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

/** What the composer was asked to do. */
const composerCalls: string[] = [];
let composerOpen = false;

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost(_props, ref) {
    useImperativeHandle(ref, () => ({
      handleLineSelectionEnd: () => {},
      handleTokenClick: () => {},
      openLineAnnotation: (range: SelectedLineRange, keyboard?: { position: unknown }) => {
        composerCalls.push(`new ${range.side} ${range.start}-${range.end}${keyboard ? ' (keyboard)' : ''}`);
      },
      startEdit: (ann: CodeAnnotation, keyboard?: { position: unknown }) => {
        composerCalls.push(`edit ${ann.id}${keyboard ? ' (keyboard)' : ''}`);
      },
      isOpen: () => composerOpen,
    }));
    return null;
  }),
}));

const { DiffViewer } = await import('./DiffViewer');
const { requestCursorEntry } = await import('../utils/lineCursor');

const hasDom = typeof document !== 'undefined';

const PATCH = [
  'diff --git a/calc.ts b/calc.ts',
  '--- a/calc.ts',
  '+++ b/calc.ts',
  '@@ -10,4 +10,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 20;',
  ' const c = 3;',
  ' const d = 4;',
  '',
].join('\n');

const COMMENT: CodeAnnotation = {
  id: 'c1', type: 'comment', filePath: 'calc.ts', lineStart: 11, lineEnd: 11, side: 'new', text: 'Why 20?', createdAt: 0,
};

const ROW = 30;
let VIEW = 600;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.if(hasDom)('DiffViewer line cursor (DOM, real Pierre)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let originalRect: HTMLElement['getBoundingClientRect'];
  const originalFetch = globalThis.fetch;
  /** The view's highlight, as the app holds it. */
  let state: { selection: SelectedLineRange | null; selectedId: string | null } = { selection: null, selectedId: null };
  let fileSteps: string[] = [];

  beforeEach(() => {
    VIEW = 600;
    composerCalls.length = 0;
    composerOpen = false;
    fileSteps = [];
    state = { selection: null, selectedId: null };
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const index = this.getAttribute('data-line-index');
      const top = index != null ? Number.parseInt(index, 10) * ROW : 0;
      const height = index != null ? ROW : VIEW;
      return { top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} } as DOMRect;
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({ oldContent: null, newContent: null }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    globalThis.fetch = originalFetch;
    document.body.replaceChildren();
  });

  function Harness({ lineCursor }: { lineCursor: boolean }) {
    const [selection, setSelection] = useState<SelectedLineRange | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    state = { selection, selectedId };
    return (
      <DiffViewer
        patch={PATCH}
        filePath="calc.ts"
        diffStyle="unified"
        annotations={[COMMENT]}
        selectedAnnotationId={selectedId}
        scrollTargetAnnotation={null}
        pendingSelection={selection}
        isFocused
        lineCursor={lineCursor}
        onCursorStepFile={(direction) => { fileSteps.push(direction); return true; }}
        onLineSelection={setSelection}
        onAddAnnotation={() => {}}
        onAddFileComment={() => {}}
        onEditAnnotation={() => {}}
        onSelectAnnotation={(id) => setSelectedId((prev) => (!id || prev === id ? null : id))}
        onDeleteAnnotation={() => {}}
      />
    );
  }

  async function mount(lineCursor = true) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness lineCursor={lineCursor} />);
    });
    for (let turn = 0; turn < 400 && !rowsRendered(host); turn += 1) {
      await act(async () => { await sleep(25); });
    }
    expect(rowsRendered(host)).toBe(true);
  }

  function rowsRendered(container: HTMLElement): boolean {
    let found = false;
    const visit = (node: ParentNode) => {
      if (node.querySelector('[data-line-type][data-line-index^="13,"]')) found = true;
      for (const el of node.querySelectorAll('*')) {
        const shadow = (el as HTMLElement).shadowRoot;
        if (shadow) visit(shadow);
      }
    };
    visit(container);
    return found;
  }

  function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => { document.body.dispatchEvent(event); });
    return event;
  }

  /** Where the cursor is: the highlighted line, or the selected comment. */
  function at(): string {
    if (state.selection && state.selectedId) return 'both';
    if (state.selection) return `${state.selection.side === 'deletions' ? '-' : '+'}${state.selection.start}`;
    if (state.selectedId) return `comment:${state.selectedId}`;
    return 'none';
  }

  test('J walks every line, stops on the comment under its line, and hands over to the next file', async () => {
    await mount();
    const walk: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      expect(press('j').defaultPrevented).toBe(true);
      walk.push(at());
    }
    expect(walk).toEqual(['+10', '-11', '+11', 'comment:c1', '+12', '+13']);
    expect(fileSteps).toEqual([]);
    expect(press('j').defaultPrevented).toBe(true);
    expect(fileSteps).toEqual(['next']);

    const back: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      press('k');
      back.push(at());
    }
    expect(back).toEqual(['+12', 'comment:c1', '+11', '-11', '+10']);
    press('k');
    expect(fileSteps).toEqual(['next', 'prev']);
  });

  test('Ctrl+D / Ctrl+U move half the rows the view shows, stopping at the file edge first', async () => {
    VIEW = 120; // four rows of 30 px: two stops a half page
    await mount();
    press('j');
    expect(at()).toBe('+10');
    expect(press('d', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(at()).toBe('+11');
    press('d', { ctrlKey: true });
    expect(at()).toBe('+12');
    press('d', { ctrlKey: true });
    expect(at()).toBe('+13'); // the last stop: not past it
    expect(fileSteps).toEqual([]);
    press('d', { ctrlKey: true });
    expect(fileSteps).toEqual(['next']);
    press('u', { ctrlKey: true });
    expect(at()).toBe('comment:c1');
    press('u', { ctrlKey: true });
    expect(at()).toBe('-11');
    press('u', { ctrlKey: true });
    expect(at()).toBe('+10');
    press('u', { ctrlKey: true });
    expect(fileSteps).toEqual(['next', 'prev']);
  });

  test('I comments on the cursor line; Enter on a comment edits it', async () => {
    await mount();
    press('j');
    press('j');
    press('j');
    expect(at()).toBe('+11');
    expect(press('i').defaultPrevented).toBe(true);
    expect(composerCalls).toEqual(['new additions 11-11 (keyboard)']);
    press('j');
    expect(at()).toBe('comment:c1');
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(composerCalls).toEqual(['new additions 11-11 (keyboard)', 'edit c1 (keyboard)']);
  });

  test('the cursor line is drawn at the full selection tint until a pointer press', async () => {
    await mount();
    const view = () => host!.querySelector('[data-line-cursor-shown]');
    expect(view()).toBeNull();
    press('j');
    expect(at()).toBe('+10');
    expect(view()).not.toBeNull();
    act(() => { view()!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(view()).toBeNull();
  });

  test('a file entered with K from the next one starts on its last line', async () => {
    requestCursorEntry('calc.ts', 'last');
    await mount();
    for (let turn = 0; turn < 40 && at() === 'none'; turn += 1) {
      await act(async () => { await sleep(10); });
    }
    expect(at()).toBe('+13');
  });

  test('no keys while the panel is not active or the composer is open', async () => {
    await mount(false);
    expect(press('j').defaultPrevented).toBe(false);
    expect(press('i').defaultPrevented).toBe(false);
    expect(at()).toBe('none');

    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    await mount(true);
    composerOpen = true;
    expect(press('j').defaultPrevented).toBe(false);
    expect(press('Enter').defaultPrevented).toBe(false);
    expect(at()).toBe('none');
    expect(composerCalls).toEqual([]);
  });
});
