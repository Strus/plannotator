/**
 * The diff line cursor's stops and keys (`J` / `K` / `I` / `Enter`).
 *
 * Failures to catch: a deletion and its addition walked in the wrong order,
 * a context row losing its old-side number (an old-side comment on it never
 * gets a stop), a comment stopping before its line or under the wrong one, a
 * file comment taking a stop, a selected range stepping from the wrong end,
 * the last stop not handing over to the next file, unchanged lines walked
 * when the diff does not show them, the key firing while typing, with a
 * modifier, in the file tree or on a button, and a stale file entry jumping a
 * later visit.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { getSingularPatch } from '@pierre/diffs';
import type { CodeAnnotation } from '@plannotator/ui/types';
import {
  carryCursor,
  findCursorIndex,
  halfPageStops,
  lineCursorKey,
  listCursorLines,
  listCursorStops,
  requestCursorEntry,
  stepCursor,
  stepCursorBy,
  takeCursorEntry,
  type CursorStop,
} from './lineCursor';

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

const describeStop = (stop: CursorStop): string =>
  stop.kind === 'line'
    ? `${stop.side === 'deletions' ? '-' : '+'}${stop.lineNumber}`
    : `comment:${stop.annotationId}`;

function annotation(id: string, lineEnd: number, side: 'old' | 'new', extra: Partial<CodeAnnotation> = {}): CodeAnnotation {
  return { id, type: 'comment', filePath: 'calc.ts', lineStart: lineEnd, lineEnd, side, createdAt: 0, ...extra };
}

describe('listCursorLines', () => {
  test('walks every row in order, a deletion before its addition, a context row on both sides', () => {
    const lines = listCursorLines(getSingularPatch(PATCH));
    expect(lines.map(describeStop)).toEqual(['+10', '-11', '+11', '+12', '+13']);
    expect(lines.map((line) => line.unifiedIndex)).toEqual([9, 10, 11, 12, 13]);
    expect(lines[0]).toMatchObject({ oldLine: 10, newLine: 10 });
    expect(lines[1]).toMatchObject({ oldLine: 11, newLine: null });
    expect(lines[2]).toMatchObject({ oldLine: null, newLine: 11 });
  });

  test('unchanged lines between hunks count only when the diff shows them all', () => {
    const hunk = { collapsedBefore: 2, additionStart: 3, additionCount: 1, deletionStart: 3, unifiedLineStart: 2, hunkContent: [{ type: 'context' as const, lines: 1, additionLineIndex: 2, deletionLineIndex: 2 }] };
    const diff = { hunks: [hunk], isPartial: false, additionLines: ['a', 'b', 'c', 'd'] };
    expect(listCursorLines(diff, false).map((line) => line.lineNumber)).toEqual([3]);
    expect(listCursorLines(diff, true).map((line) => line.lineNumber)).toEqual([1, 2, 3, 4]);
    // A patch alone has no file to show between hunks.
    expect(listCursorLines({ ...diff, isPartial: true }, true).map((line) => line.lineNumber)).toEqual([3]);
  });
});

describe('listCursorStops', () => {
  const lines = listCursorLines(getSingularPatch(PATCH));

  test('places each line comment right after the line it is drawn under', () => {
    const stops = listCursorStops(lines, [
      annotation('on-added', 11, 'new'),
      annotation('on-deleted', 11, 'old'),
      annotation('second-on-added', 11, 'new'),
      annotation('old-side-context', 12, 'old'),
    ]);
    expect(stops.map(describeStop)).toEqual([
      '+10',
      '-11', 'comment:on-deleted',
      '+11', 'comment:on-added', 'comment:second-on-added',
      '+12', 'comment:old-side-context',
      '+13',
    ]);
  });

  test('a range comment stops under its last line; file comments and unshown lines get none', () => {
    const stops = listCursorStops(lines, [
      annotation('range', 12, 'new', { lineStart: 10 }),
      annotation('file', 1, 'new', { scope: 'file' }),
      annotation('elsewhere', 40, 'new'),
    ]);
    expect(stops.map(describeStop)).toEqual(['+10', '-11', '+11', '+12', 'comment:range', '+13']);
  });
});

describe('findCursorIndex and stepCursor', () => {
  const stops = listCursorStops(listCursorLines(getSingularPatch(PATCH)), [annotation('c1', 11, 'new')]);

  test('J walks lines and comments, then hands over at the end; K at the start', () => {
    let index = findCursorIndex(stops, { kind: 'range', range: { start: 11, end: 11, side: 'additions' } }, 'next');
    expect(index).toBe(2);
    expect(stepCursor(stops.length, index, 'next')).toEqual({ index: 3 });
    expect(describeStop(stops[3])).toBe('comment:c1');
    index = findCursorIndex(stops, { kind: 'comment', annotationId: 'c1' }, 'next');
    expect(stepCursor(stops.length, index, 'next')).toEqual({ index: 4 });
    expect(stepCursor(stops.length, stops.length - 1, 'next')).toEqual({ edge: 'end' });
    expect(stepCursor(stops.length, 0, 'prev')).toEqual({ edge: 'start' });
  });

  test('a selected range steps from its last line down and its first line up', () => {
    const range = { kind: 'range' as const, range: { start: 10, end: 12, side: 'additions' as const } };
    expect(describeStop(stops[findCursorIndex(stops, range, 'next')!])).toBe('+12');
    expect(describeStop(stops[findCursorIndex(stops, range, 'prev')!])).toBe('+10');
  });

  test('a context row is found from either side', () => {
    expect(findCursorIndex(stops, { kind: 'range', range: { start: 10, end: 10, side: 'deletions' } }, 'next')).toBe(0);
  });

  test('with no position, J starts on the line on screen, else the first stop', () => {
    expect(stepCursor(stops.length, null, 'next', 4)).toEqual({ index: 4 });
    expect(stepCursor(stops.length, null, 'next')).toEqual({ index: 0 });
    expect(stepCursor(0, null, 'next')).toEqual({ edge: 'end' });
  });
});

describe('half-page moves (Ctrl+D / Ctrl+U)', () => {
  test('move half the rows the view shows, at least one', () => {
    expect(halfPageStops(600, 20)).toBe(15);
    expect(halfPageStops(30, 20)).toBe(1);
    expect(halfPageStops(600, 0)).toBe(1);
  });

  test('stop on the file edge, then go on to the next file from it', () => {
    expect(stepCursorBy(20, 3, 'next', 5)).toEqual({ index: 8 });
    expect(stepCursorBy(20, 17, 'next', 5)).toEqual({ index: 19 });
    expect(stepCursorBy(20, 19, 'next', 5)).toEqual({ edge: 'end' });
    expect(stepCursorBy(20, 8, 'prev', 5)).toEqual({ index: 3 });
    expect(stepCursorBy(20, 2, 'prev', 5)).toEqual({ index: 0 });
    expect(stepCursorBy(20, 0, 'prev', 5)).toEqual({ edge: 'start' });
  });

  test('with no position, land where J would', () => {
    expect(stepCursorBy(20, null, 'next', 5, 4)).toEqual({ index: 4 });
  });

  test('All files: the rest of the move carries into the next file with stops', () => {
    // Files of 3, 0 (collapsed) and 4 stops.
    const counts = [3, 0, 4];
    expect(carryCursor({ file: 0, index: 0 }, 2, 'next', counts)).toEqual({ file: 0, index: 2 });
    expect(carryCursor({ file: 0, index: 1 }, 3, 'next', counts)).toEqual({ file: 2, index: 1 });
    expect(carryCursor({ file: 2, index: 1 }, 3, 'prev', counts)).toEqual({ file: 0, index: 1 });
    // Past the last file: its last stop; from there, nothing.
    expect(carryCursor({ file: 2, index: 1 }, 10, 'next', counts)).toEqual({ file: 2, index: 3 });
    expect(carryCursor({ file: 2, index: 3 }, 10, 'next', counts)).toBeNull();
    expect(carryCursor({ file: 0, index: 0 }, 10, 'prev', counts)).toBeNull();
  });
});

describe.if(typeof document !== 'undefined')('lineCursorKey', () => {
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
    const seen: { action: ReturnType<typeof lineCursorKey> } = { action: null };
    const listener = (event: Event) => { seen.action = lineCursorKey(event as KeyboardEvent); };
    window.addEventListener('keydown', listener);
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    window.removeEventListener('keydown', listener);
    return seen.action;
  };

  afterEach(() => document.body.replaceChildren());

  test('J, K, I and Enter', () => {
    expect(press('j')).toBe('next');
    expect(press('k')).toBe('prev');
    expect(press('i')).toBe('insert');
    expect(press('Enter')).toBe('insert');
  });

  test('Ctrl+D and Ctrl+U, by the physical key on another layout too; never with Cmd or another modifier', () => {
    expect(press('d', { ctrlKey: true })).toBe('pageDown');
    expect(press('u', { ctrlKey: true })).toBe('pageUp');
    expect(press('в', { ctrlKey: true, code: 'KeyD' })).toBe('pageDown');
    expect(press('d', { metaKey: true })).toBeNull();
    expect(press('d', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press('d')).toBeNull();
    expect(press('j', { ctrlKey: true })).toBeNull();
  });

  test('never with a modifier, while typing, in the file tree, or Enter on a button', () => {
    expect(press('j', { metaKey: true })).toBeNull();
    expect(press('j', { ctrlKey: true })).toBeNull();
    expect(press('J', { shiftKey: true })).toBeNull();
    const textarea = document.body.appendChild(document.createElement('textarea'));
    expect(press('j', {}, textarea)).toBeNull();
    const tree = document.body.appendChild(document.createElement('div'));
    tree.setAttribute('role', 'tree');
    const row = tree.appendChild(document.createElement('div'));
    expect(press('j', {}, row)).toBeNull();
    const button = document.body.appendChild(document.createElement('button'));
    expect(press('Enter', {}, button)).toBeNull();
    expect(press('j', {}, button)).toBe('next');
  });

  test('never while a modal is open', () => {
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('aria-modal', 'true');
    expect(press('j')).toBeNull();
  });
});

describe('cursor entry into another file', () => {
  test('is taken once, by that file, and only while fresh', () => {
    requestCursorEntry('b.ts', 'last', 1000);
    expect(takeCursorEntry('a.ts', 1001)).toBeNull();
    expect(takeCursorEntry('b.ts', 1001)).toBe('last');
    expect(takeCursorEntry('b.ts', 1002)).toBeNull();
    requestCursorEntry('b.ts', 'first', 1000);
    expect(takeCursorEntry('b.ts', 1000 + 10_000)).toBeNull();
  });
});
