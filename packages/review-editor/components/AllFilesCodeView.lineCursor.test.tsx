/**
 * `J` / `K` in All files move the line cursor through every expanded file's
 * lines and comments, crossing from one file into the next (lineCursor.ts).
 *
 * Uses the CodeView stand-in of AllFilesCodeView.changeNavigation.test.tsx:
 * each item renders through the REAL Pierre `FileDiff`, so the stops come from
 * the parsed hunks the view really holds.
 *
 * Guards: the last line of a file not going on to the next file's first (and
 * K back to the previous file's last), a collapsed file taking the cursor, a
 * comment of another file stopped on, the highlight not moving to the file
 * the cursor entered, `Ctrl+D` / `Ctrl+U` not carrying across files, `I`
 * opening the composer for the wrong file or lines, and `Enter` on a comment
 * not editing it.
 *
 * DOM-gated (DOM_TESTS=1), run in the DOM lanes with `--isolate` (this file
 * mocks '@pierre/diffs/react' and puts it back in afterAll).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useCallback, useImperativeHandle, useRef, useState } from 'react';
import type { CodeAnnotation, SelectedLineRange } from '@plannotator/ui/types';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';

const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
const realResolveSyntaxTheme = (await import('@plannotator/ui/utils/syntaxTheme')).resolveSyntaxTheme;

const ROW = 30;
const FILE = 3000;
let VIEW = 200;
/** Space above the first file (the review's leading content). Most tests
 *  start the first change below the middle of the view; one starts at 0. */
let LEAD = 200;

let scrollTop = 0;
let lineScrolls: Array<{ id: string; lineNumber: number; side: string }> = [];
/** Item ids the stand-in leaves out of its rendered window. */
let notRendered = new Set<string>();
let collapsedIds = new Set<string>();

mock.module('../workerPool', () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

mock.module('../hooks/usePierreTheme', () => ({
  buildLineBgOverrides: () => '',
  resolveSyntaxTheme: realResolveSyntaxTheme,
  usePierreTheme: () => ({ type: 'light', css: '' }),
}));

interface StandInItem {
  id: string;
  type: string;
  collapsed?: boolean;
  fileDiff?: Parameters<typeof realPierreDiffsReact.FileDiff>[0]['fileDiff'];
}

mock.module('@pierre/diffs/react', () => ({
  ...realPierreDiffsReact,
  CodeView: React.forwardRef(function StandInCodeView(
    props: { initialItems?: StandInItem[]; className?: string; containerRef?: React.Ref<HTMLDivElement> },
    ref: React.ForwardedRef<unknown>,
  ) {
    const items = props.initialItems ?? [];
    const wrappers = useRef(new Map<string, HTMLElement>());
    const container = useRef<HTMLDivElement | null>(null);
    useImperativeHandle(ref, () => ({
      getItem: (id: string) => {
        const item = items.find((candidate) => candidate.id === id);
        return item ? { ...item, collapsed: collapsedIds.has(id) || collapsedIds.has(id.split('?')[0]) } : undefined;
      },
      updateItem: () => true,
      scrollTo: (target: { type: string; id: string; lineNumber: number; side: string }) => {
        if (target.type !== 'line') return;
        lineScrolls.push({ id: target.id, lineNumber: target.lineNumber, side: target.side });
        const index = items.findIndex((item) => item.id === target.id);
        const row = findRow(wrappers.current.get(target.id), target.lineNumber, target.side);
        const unified = row ? Number.parseInt(row.getAttribute('data-line-index')!, 10) : 0;
        scrollTop = Math.max(0, LEAD + index * FILE + unified * ROW - VIEW / 2 + ROW / 2);
      },
      setSelectedLines: () => {},
      getSelectedLines: () => null,
      clearSelectedLines: () => {},
      getInstance: () => ({
        getContainerElement: () => container.current,
        getRenderedItems: () => items
          .filter((item) => !notRendered.has(item.id) && wrappers.current.has(item.id))
          .map((item) => ({ id: item.id, type: 'diff', item, element: wrappers.current.get(item.id)! })),
        getScrollTop: () => scrollTop,
        getTopForItem: (id: string) => LEAD + Math.max(0, items.findIndex((item) => item.id === id)) * FILE,
        getScrollHeight: () => LEAD + items.length * FILE,
        getHeight: () => VIEW,
        scrollTo: () => {},
      }),
    }));
    const setContainer = (el: HTMLDivElement | null) => {
      container.current = el;
      if (typeof props.containerRef === 'function') props.containerRef(el);
      else if (props.containerRef) (props.containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    };
    return (
      <div ref={setContainer} className={props.className} data-standin-view="">
        {items.map((item, index) => (
          <div
            key={item.id}
            data-file-offset={LEAD + index * FILE}
            ref={(el) => {
              if (el) wrappers.current.set(item.id, el);
            }}
          >
            {item.fileDiff ? (
              <realPierreDiffsReact.FileDiff fileDiff={item.fileDiff} options={{ diffStyle: 'unified' }} />
            ) : null}
          </div>
        ))}
      </div>
    );
  }),
  EditProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useStableCallback: <T extends (...args: never[]) => unknown>(callback: T): T => {
    const callbackRef = useRef(callback);
    callbackRef.current = callback;
    return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
  },
}));

/** What the composer was asked to do. */
const composerCalls: string[] = [];

mock.module('./ToolbarHost', () => ({
  ToolbarHost: React.forwardRef(function MockToolbarHost(props: { filePath: string }, ref) {
    useImperativeHandle(ref, () => ({
      handleLineSelectionEnd: () => {},
      openLineAnnotation: (range: SelectedLineRange, keyboard?: unknown) => {
        composerCalls.push(`new ${props.filePath} ${range.side} ${range.start}${keyboard ? ' (keyboard)' : ''}`);
      },
      handleTokenClick: () => {},
      startEdit: (ann: CodeAnnotation, keyboard?: unknown) => {
        composerCalls.push(`edit ${ann.id}${keyboard ? ' (keyboard)' : ''}`);
      },
      isOpen: () => false,
    }), [props.filePath]);
    return null;
  }),
}));

const { AllFilesCodeView } = await import('./AllFilesCodeView');

function findRow(root: ParentNode | undefined, lineNumber: number, side: string): Element | null {
  if (!root) return null;
  const type = side === 'deletions' ? 'change-deletion' : 'change-addition';
  const visit = (node: ParentNode): Element | null => {
    const hit = node.querySelector(`[data-line="${lineNumber}"][data-line-type="${type}"]`);
    if (hit) return hit;
    for (const el of node.querySelectorAll('*')) {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) {
        const found = visit(shadow);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(root);
}

/** The file wrapper a node sits in (crossing Pierre's shadow root). */
function fileOffsetOf(el: Element): number | null {
  let node: Node | null = el;
  while (node) {
    if (node instanceof HTMLElement && node.hasAttribute('data-file-offset')) {
      return Number(node.getAttribute('data-file-offset'));
    }
    const parent: Node | null = node.parentNode;
    node = parent ?? ((node.getRootNode() as ShadowRoot).host ?? null);
    if (node === el) break;
  }
  return null;
}

const patch = (path: string, body: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ''].join('\n');

const FILES: DiffFile[] = [
  {
    path: 'a.ts',
    patch: patch('a.ts', ['@@ -1,3 +1,3 @@', ' a1', '-a2', '+A2', ' a3']),
    additions: 1,
    deletions: 1,
    status: 'modified',
  },
  {
    path: 'b.ts',
    patch: patch('b.ts', ['@@ -1,2 +1,2 @@', '-b1', '+B1', ' b2']),
    additions: 1,
    deletions: 1,
    status: 'modified',
  },
  {
    path: 'c.ts',
    patch: patch('c.ts', ['@@ -1,2 +1,3 @@', ' c1', '+c1b', ' c2']),
    additions: 1,
    deletions: 0,
    status: 'modified',
  },
];

const COMMENTS: CodeAnnotation[] = [
  { id: 'on-a', type: 'comment', filePath: 'a.ts', lineStart: 2, lineEnd: 2, side: 'new', text: 'a', createdAt: 0 },
  // Same line number in another file: never a stop of a.ts.
  { id: 'on-b', type: 'comment', filePath: 'b.ts', lineStart: 2, lineEnd: 2, side: 'new', text: 'b', createdAt: 0 },
];

const hasDom = typeof document !== 'undefined';

describe.if(hasDom)('AllFilesCodeView line cursor (DOM, real Pierre rows)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let originalRect: HTMLElement['getBoundingClientRect'];
  let state: { selection: SelectedLineRange | null; selectedId: string | null } = { selection: null, selectedId: null };

  beforeEach(() => {
    VIEW = 200;
    LEAD = 200;
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    scrollTop = 0;
    lineScrolls = [];
    notRendered = new Set();
    collapsedIds = new Set();
    composerCalls.length = 0;
    state = { selection: null, selectedId: null };
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const rect = (top: number, height: number) =>
        ({ top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} }) as DOMRect;
      const index = this.getAttribute('data-line-index');
      const offset = fileOffsetOf(this);
      if (index != null && offset != null) return rect(offset + Number.parseInt(index, 10) * ROW - scrollTop, ROW);
      if (this.hasAttribute('data-file-offset')) return rect(Number(this.getAttribute('data-file-offset')) - scrollTop, FILE);
      return rect(0, VIEW);
    };
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  afterAll(() => {
    mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
  });

  function Harness() {
    const [selection, setSelection] = useState<SelectedLineRange | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    state = { selection, selectedId };
    return (
      <AllFilesCodeView
        files={FILES}
        diffStyle="unified"
        annotations={COMMENTS}
        selectedAnnotationId={selectedId}
        scrollTargetAnnotation={null}
        pendingSelection={selection}
        isActive
        onLineSelection={(range) => setSelection(range ? { ...range, side: range.side ?? 'additions' } : null)}
        onAddAnnotationForFile={() => {}}
        onEditAnnotation={() => {}}
        onSelectAnnotation={(id) => setSelectedId((prev) => (!id || prev === id ? null : id))}
        onDeleteAnnotation={() => {}}
      />
    );
  }

  async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness />);
    });
    for (let turn = 0; turn < 200 && countRows() < 4; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    expect(countRows()).toBeGreaterThanOrEqual(4);
  }

  function countRows(): number {
    let count = 0;
    const visit = (node: ParentNode) => {
      for (const el of node.querySelectorAll('*')) {
        if (el.getAttribute('data-line-type')?.startsWith('change-') && el.closest('[data-gutter]') == null) count += 1;
        const shadow = (el as HTMLElement).shadowRoot;
        if (shadow) visit(shadow);
      }
    };
    if (host) visit(host);
    return count;
  }

  function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event;
  }

  function at(): string {
    if (state.selection && state.selectedId) return 'both';
    if (state.selection) return `${state.selection.side === 'deletions' ? '-' : '+'}${state.selection.start}`;
    if (state.selectedId) return `comment:${state.selectedId}`;
    return 'none';
  }

  const walk = (key: string, times: number): string[] => Array.from({ length: times }, () => {
    press(key);
    return at();
  });

  test('J walks a file, its comment, then goes on to the next file; K walks back across', async () => {
    await mount();
    expect(walk('j', 9)).toEqual([
      '+1', '-2', '+2', 'comment:on-a', '+3', // a.ts
      '-1', '+1', '+2', 'comment:on-b', // b.ts
    ]);
    expect(walk('j', 3)).toEqual(['+1', '+2', '+3']); // c.ts
    // Past the last file: the key is left alone.
    expect(press('j').defaultPrevented).toBe(false);
    expect(walk('k', 4)).toEqual(['+2', '+1', 'comment:on-b', '+2']);
  });

  test('the cursor line is drawn at the full selection tint until a pointer press', async () => {
    await mount();
    const view = () => host!.querySelector('[data-line-cursor-shown]');
    expect(view()).toBeNull();
    press('j');
    expect(at()).toBe('+1');
    expect(view()).not.toBeNull();
    act(() => { view()!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(view()).toBeNull();
  });

  test('Ctrl+D / Ctrl+U move half the view, carrying on across files as one diff', async () => {
    await mount(); // a 200 px view of 30 px rows: three stops a half page
    press('j');
    expect(at()).toBe('+1');
    const step = (key: 'd' | 'u') => {
      press(key, { ctrlKey: true });
      return at();
    };
    // a.ts: +1 -2 +2 on-a +3 | b.ts: -1 +1 +2 on-b | c.ts: +1 +2 +3
    expect([step('d'), step('d'), step('d'), step('d')]).toEqual(['comment:on-a', '+1', '+1', '+3']);
    // On the very last line: nothing further, and the key is left alone.
    expect(press('d', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect([step('u'), step('u')]).toEqual(['comment:on-b', '-1']);
  });

  test('a collapsed file is skipped', async () => {
    collapsedIds = new Set(['b.ts']);
    await mount();
    expect(walk('j', 6)).toEqual(['+1', '-2', '+2', 'comment:on-a', '+3', '+1']);
    expect(walk('j', 2)).toEqual(['+2', '+3']); // c.ts, not b.ts
    expect(walk('k', 3)).toEqual(['+2', '+1', '+3']); // back across into a.ts
  });

  test('I comments on the cursor line of its file; Enter on a comment edits it', async () => {
    await mount();
    walk('j', 3);
    expect(at()).toBe('+2');
    expect(press('i').defaultPrevented).toBe(true);
    press('j');
    expect(at()).toBe('comment:on-a');
    expect(press('Enter').defaultPrevented).toBe(true);
    walk('j', 3);
    expect(at()).toBe('+1');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    press('i');
    expect(composerCalls).toEqual([
      'new a.ts additions 2 (keyboard)',
      'edit on-a (keyboard)',
      'new b.ts additions 1 (keyboard)',
    ]);
  });
});
