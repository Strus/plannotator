/**
 * Escape in a comment composer the line cursor opened (`I` / `Enter`) saves
 * what was written (DOM-gated, DOM_TESTS=1).
 *
 * Failures to catch: Escape throws away (or only drafts) a comment typed
 * from the keyboard; it saves an empty one; an edit opened from the keyboard
 * is not updated, or an emptied edit deletes the comment's text; a composer
 * the pointer opened starts saving on Escape (it keeps its draft and saves
 * nothing, as before); the keyboard composer opens behind the Inbox's chooser
 * instead of as a comment box; and the view is not told the composer closed,
 * so its cursor would stay lost.
 */
import { afterEach, expect, test } from 'bun:test';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '@plannotator/ui/types';
import type { ToolbarHostHandle } from './ToolbarHost';

const hasDom = typeof document !== 'undefined';
const hostModule = hasDom ? await import('./ToolbarHost') : null;

const PATCH = [
  'diff --git a/refund.ts b/refund.ts',
  '--- a/refund.ts',
  '+++ b/refund.ts',
  '@@ -1,3 +1,3 @@',
  ' export function retries(): number {',
  '-  return 3;',
  '+  return 4;',
  ' }',
  '',
].join('\n');

const AT = { position: { top: 120, left: 200 } };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

async function mount(extra: Record<string, unknown> = {}) {
  const ToolbarHost = hostModule!.ToolbarHost;
  const ref = createRef<ToolbarHostHandle>();
  const added: Array<string | undefined> = [];
  const edited: Array<[string, string | undefined]> = [];
  let ended = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <ToolbarHost
        ref={ref}
        patch={PATCH}
        filePath="refund.ts"
        isFocused
        onLineSelection={() => {}}
        onAddAnnotation={(_type, text) => { added.push(text); }}
        onEditAnnotation={(id, text) => { edited.push([id, text]); }}
        onKeyboardComposeEnd={() => { ended += 1; }}
        {...extra}
      />,
    );
  });
  return { ref, added, edited, ended: () => ended };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

function composer(): HTMLTextAreaElement {
  const area = document.querySelector<HTMLTextAreaElement>('textarea');
  if (!area) throw new Error('no composer');
  return area;
}

async function type(text: string) {
  const area = composer();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function escape() {
  await act(async () => {
    composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await settle();
}

test.skipIf(!hasDom)('a keyboard comment: Escape saves it and closes', async () => {
  const { ref, added, ended } = await mount();
  await act(async () => ref.current!.openLineAnnotation({ start: 2, end: 2, side: 'additions' }, AT));
  await settle();
  expect(ref.current!.isOpen()).toBe(true);
  await type('Why four?');
  await escape();
  expect(added).toEqual(['Why four?']);
  expect(document.querySelector('textarea')).toBeNull();
  expect(ref.current!.isOpen()).toBe(false);
  expect(ended()).toBe(1);
});

test.skipIf(!hasDom)('an empty keyboard comment: Escape closes and saves nothing', async () => {
  const { ref, added, ended } = await mount();
  await act(async () => ref.current!.openLineAnnotation({ start: 2, end: 2, side: 'additions' }, AT));
  await settle();
  await escape();
  expect(added).toEqual([]);
  expect(document.querySelector('textarea')).toBeNull();
  expect(ended()).toBe(1);
});

test.skipIf(!hasDom)('a keyboard edit: Escape saves the new text; emptied, it keeps the comment as it was', async () => {
  const { ref, edited } = await mount();
  const ann: CodeAnnotation = { id: 'c1', type: 'comment', filePath: 'refund.ts', lineStart: 2, lineEnd: 2, side: 'new', text: 'old text', createdAt: 0 };
  await act(async () => ref.current!.startEdit(ann, AT));
  await settle();
  expect(composer().value).toBe('old text');
  await type('new text');
  await escape();
  expect(edited).toEqual([['c1', 'new text']]);

  await act(async () => ref.current!.startEdit(ann, AT));
  await settle();
  await type('   ');
  await escape();
  expect(edited).toEqual([['c1', 'new text']]);
  expect(document.querySelector('textarea')).toBeNull();
});

test.skipIf(!hasDom)('a composer the pointer opened: Escape keeps the draft and saves nothing', async () => {
  const { ref, added, ended } = await mount();
  await act(async () => ref.current!.handleLineSelectionEnd({ start: 2, end: 2, side: 'additions' }));
  await settle();
  await type('draft only');
  await escape();
  expect(added).toEqual([]);
  expect(document.querySelector('textarea')).toBeNull();
  expect(ended()).toBe(0);
  // The draft comes back on the same lines.
  await act(async () => ref.current!.handleLineSelectionEnd({ start: 2, end: 2, side: 'additions' }));
  await settle();
  expect(composer().value).toBe('draft only');
});

test.skipIf(!hasDom)('with a chooser (selection actions), the keyboard opens the comment box itself', async () => {
  const { ref } = await mount({ selectionActions: { onAsk: () => {} } });
  await act(async () => ref.current!.openLineAnnotation({ start: 2, end: 2, side: 'additions' }, AT));
  await settle();
  expect(document.querySelector('textarea')).not.toBeNull();
});
