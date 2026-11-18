import type { Hunk } from '@pierre/diffs';
import type { CodeAnnotation, SelectedLineRange } from '@plannotator/ui/types';
import { isFileScopedAnnotation } from './annotationScope';
import { isTypingOrigin } from './changeNavigation';

/**
 * The keyboard line cursor of a diff (`J` / `K` move it, `I` / `Enter` comment,
 * the `review-line-cursor` scope).
 *
 * A file is a list of stops in the order the diff shows them: every rendered
 * line, and after a line, each line comment drawn under it. `J` on the last
 * stop of a file goes on to the first stop of the next file, `K` on the first
 * stop to the last stop of the previous one.
 */

export type CursorSide = 'additions' | 'deletions';

export interface LineStop {
  kind: 'line';
  /** The line number on `side` (the old file's for a deletion). */
  lineNumber: number;
  side: CursorSide;
  /** Pierre's unified row index (`data-line-index` "u,s"). */
  unifiedIndex: number;
  /** Old and new line numbers this row shows (a context row has both). */
  oldLine: number | null;
  newLine: number | null;
}

export interface CommentStop {
  kind: 'comment';
  annotationId: string;
  /** The line the comment is drawn under. */
  lineNumber: number;
  side: CursorSide;
  unifiedIndex: number;
}

export type CursorStop = LineStop | CommentStop;

export type CursorHunk = Pick<
  Hunk,
  'collapsedBefore' | 'additionStart' | 'additionCount' | 'deletionStart' | 'unifiedLineStart' | 'hunkContent'
>;

export interface CursorDiff {
  hunks: readonly CursorHunk[];
  /** False once the full file contents are known (unchanged lines can be shown). */
  isPartial?: boolean;
  additionLines?: readonly unknown[];
}

/**
 * Every line the diff renders, in order. Unchanged lines between hunks count
 * only when the diff shows them all (`expandUnchanged` over full contents);
 * a gap the person opened by hand is not walked.
 */
export function listCursorLines(diff: CursorDiff | null | undefined, expandUnchanged = false): LineStop[] {
  const stops: LineStop[] = [];
  if (!diff) return stops;
  const withGaps = expandUnchanged && diff.isPartial === false;
  const pushContext = (unified: number, oldLine: number, newLine: number) => {
    stops.push({ kind: 'line', lineNumber: newLine, side: 'additions', unifiedIndex: unified, oldLine, newLine });
  };
  let lastNewEnd = 0;
  let lastOldEnd = 0;
  let lastUnifiedEnd = 0;
  for (const hunk of diff.hunks ?? []) {
    if (withGaps && hunk.collapsedBefore > 0) {
      for (let i = 0; i < hunk.collapsedBefore; i++) {
        pushContext(
          hunk.unifiedLineStart - hunk.collapsedBefore + i,
          hunk.deletionStart - hunk.collapsedBefore + i,
          hunk.additionStart - hunk.collapsedBefore + i,
        );
      }
    }
    let unified = hunk.unifiedLineStart;
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent ?? []) {
      if (content.type === 'context') {
        for (let i = 0; i < content.lines; i++) pushContext(unified + i, oldLine + i, newLine + i);
        unified += content.lines;
        oldLine += content.lines;
        newLine += content.lines;
        continue;
      }
      for (let i = 0; i < content.deletions; i++) {
        stops.push({ kind: 'line', lineNumber: oldLine + i, side: 'deletions', unifiedIndex: unified + i, oldLine: oldLine + i, newLine: null });
      }
      unified += content.deletions;
      oldLine += content.deletions;
      for (let i = 0; i < content.additions; i++) {
        stops.push({ kind: 'line', lineNumber: newLine + i, side: 'additions', unifiedIndex: unified + i, oldLine: null, newLine: newLine + i });
      }
      unified += content.additions;
      newLine += content.additions;
    }
    lastNewEnd = newLine;
    lastOldEnd = oldLine;
    lastUnifiedEnd = unified;
  }
  if (withGaps && diff.additionLines && stops.length > 0) {
    const trailing = diff.additionLines.length - (lastNewEnd - 1);
    for (let i = 0; i < trailing; i++) pushContext(lastUnifiedEnd + i, lastOldEnd + i, lastNewEnd + i);
  }
  return stops;
}

/** The comments a cursor can stop on: line comments, not file comments. */
type CursorAnnotation = Pick<CodeAnnotation, 'id' | 'lineEnd' | 'side' | 'scope'>;

/**
 * The lines with each line comment placed after the line it is drawn under
 * (its last line, on its side), in the order the comments are given.
 * A comment whose line is not shown gets no stop.
 */
export function listCursorStops(lines: readonly LineStop[], annotations: readonly CursorAnnotation[]): CursorStop[] {
  const byOld = new Map<number, CursorAnnotation[]>();
  const byNew = new Map<number, CursorAnnotation[]>();
  for (const ann of annotations) {
    if (isFileScopedAnnotation(ann as CodeAnnotation)) continue;
    const map = ann.side === 'old' ? byOld : byNew;
    const list = map.get(ann.lineEnd);
    if (list) list.push(ann);
    else map.set(ann.lineEnd, [ann]);
  }
  if (byOld.size === 0 && byNew.size === 0) return [...lines];
  const stops: CursorStop[] = [];
  const placed = new Set<string>();
  for (const line of lines) {
    stops.push(line);
    const here = [
      ...(line.oldLine != null ? byOld.get(line.oldLine) ?? [] : []),
      ...(line.newLine != null ? byNew.get(line.newLine) ?? [] : []),
    ];
    for (const ann of here) {
      if (placed.has(ann.id)) continue;
      placed.add(ann.id);
      stops.push({
        kind: 'comment',
        annotationId: ann.id,
        lineNumber: line.lineNumber,
        side: line.side,
        unifiedIndex: line.unifiedIndex,
      });
    }
  }
  return stops;
}

/** A highlighted line range (Pierre's may leave the side unset: the new side). */
export type CursorRange = SelectedLineRange;

export function toCursorRange(range: { start: number; end: number; side?: CursorSide; endSide?: CursorSide }): CursorRange {
  return {
    start: range.start,
    end: range.end,
    side: range.side ?? 'additions',
    ...(range.endSide ? { endSide: range.endSide } : {}),
  };
}

/** Where the cursor is now, read from what the view highlights. */
export type CursorPosition =
  | { kind: 'comment'; annotationId: string }
  | { kind: 'range'; range: CursorRange };

/**
 * The stop index of the current position, for a step in `direction`. A range
 * of several lines steps from its last line going down and from its first
 * going up. Null when the position is not on this file's stops.
 */
export function findCursorIndex(
  stops: readonly CursorStop[],
  position: CursorPosition | null,
  direction: 'next' | 'prev',
): number | null {
  if (!position) return null;
  if (position.kind === 'comment') {
    const index = stops.findIndex((stop) => stop.kind === 'comment' && stop.annotationId === position.annotationId);
    return index === -1 ? null : index;
  }
  const { range } = position;
  const low = Math.min(range.start, range.end);
  const high = Math.max(range.start, range.end);
  const startSide = range.side;
  const endSide = range.endSide ?? range.side;
  const line = direction === 'next' ? high : low;
  const side = direction === 'next' ? (range.start <= range.end ? endSide : startSide) : (range.start <= range.end ? startSide : endSide);
  const index = stops.findIndex((stop) => stop.kind === 'line' && lineStopMatches(stop, line, side));
  return index === -1 ? null : index;
}

/** A context row is on both sides: it matches its old number on the deletions side too. */
function lineStopMatches(stop: LineStop, line: number, side: CursorSide): boolean {
  if (side === 'additions') return stop.newLine === line;
  return stop.oldLine === line;
}

export type CursorStep = { index: number } | { edge: 'end' | 'start' };

/**
 * The stop a `J` (`next`) or `K` (`prev`) lands on. With no current stop it
 * lands on `fallback` (the first line on screen), else the first stop.
 * Past the last stop it is the file's `end`, before the first its `start`:
 * the caller moves on to the next or previous file.
 */
export function stepCursor(
  stopCount: number,
  current: number | null,
  direction: 'next' | 'prev',
  fallback: number | null = null,
): CursorStep {
  if (current == null) {
    if (stopCount === 0) return { edge: direction === 'next' ? 'end' : 'start' };
    const start = fallback != null && fallback >= 0 && fallback < stopCount ? fallback : 0;
    return { index: start };
  }
  const target = direction === 'next' ? current + 1 : current - 1;
  if (target >= stopCount) return { edge: 'end' };
  if (target < 0) return { edge: 'start' };
  return { index: target };
}

/** The one-line range a line stop highlights. */
export function rangeOfLineStop(stop: LineStop): SelectedLineRange {
  return { start: stop.lineNumber, end: stop.lineNumber, side: stop.side };
}

/** The rendered row of a stop inside `root` (shadow roots included), or null. */
export function cursorRowSelector(stop: CursorStop): string {
  return `[data-line-index^="${stop.unifiedIndex},"]`;
}

export type LineCursorKey = 'next' | 'prev' | 'pageDown' | 'pageUp' | 'insert';

/**
 * The views listen in the capture phase, so the window-level file list keys
 * (`J` / `K` switch files) see a handled key as taken; a key the cursor does
 * not use still reaches them.
 */
export const LINE_CURSOR_CAPTURE = true;

/**
 * The cursor action a key asks for: `J` next, `K` previous, `Ctrl+D` /
 * `Ctrl+U` half a view down / up (the Control key on every system, as in
 * Vim; by its physical key, so other layouts get it too), `I` or `Enter`
 * comment. Never with another modifier, while typing, while an IME composes,
 * or once another handler took the key; never from a focused tree, list or
 * menu. `Enter` on a button, link, tab or tree row is that control's own.
 */
export function lineCursorKey(event: KeyboardEvent): LineCursorKey | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.altKey || event.shiftKey) return null;
  const key = event.key;
  let action: LineCursorKey | null = null;
  if (event.ctrlKey) {
    if (key === 'd' || key === 'D' || event.code === 'KeyD') action = 'pageDown';
    else if (key === 'u' || key === 'U' || event.code === 'KeyU') action = 'pageUp';
  } else if (key === 'j' || key === 'J') action = 'next';
  else if (key === 'k' || key === 'K') action = 'prev';
  else if (key === 'i' || key === 'I' || key === 'Enter') action = 'insert';
  if (!action) return null;
  if (isTypingOrigin(event)) return null;
  // A focused tree, list or menu keeps its own keys (the file tree's J / K).
  if (isInsideOrigin(event, '[role="tree"], [role="listbox"], [role="menu"], [role="dialog"], [role="tablist"]')) return null;
  if (key === 'Enter' && isInteractiveOrigin(event)) return null;
  // A modal (a dialog, the shortcut map, a confirm) owns the keys.
  if (typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]')) return null;
  return action;
}

/**
 * How many stops `Ctrl+D` / `Ctrl+U` move: half the rows the view shows, as
 * Vim's default `scroll`. At least one.
 */
export function halfPageStops(viewHeight: number, rowHeight: number): number {
  if (!(rowHeight > 0) || !(viewHeight > 0)) return 1;
  return Math.max(1, Math.floor(viewHeight / rowHeight / 2));
}

/**
 * A move of `count` stops through a run of files read as one (All files):
 * what is left after a file's last stop carries on into the next file with
 * stops (`stopCounts`, one per file in order; 0 for a file that has none).
 * Past the last file it stops on the last stop. Null when the cursor is
 * already on the first or last stop of them all.
 */
export function carryCursor(
  start: { file: number; index: number },
  count: number,
  direction: 'next' | 'prev',
  stopCounts: readonly number[],
): { file: number; index: number } | null {
  let { file, index } = start;
  let remaining = Math.max(1, count);
  let moved = false;
  for (;;) {
    const room = direction === 'next' ? stopCounts[file] - 1 - index : index;
    if (remaining <= room) return { file, index: direction === 'next' ? index + remaining : index - remaining };
    let next = file + (direction === 'next' ? 1 : -1);
    while (next >= 0 && next < stopCounts.length && stopCounts[next] === 0) next += direction === 'next' ? 1 : -1;
    if (next < 0 || next >= stopCounts.length) {
      if (room === 0 && !moved) return null;
      return { file, index: direction === 'next' ? stopCounts[file] - 1 : 0 };
    }
    remaining -= room + 1;
    moved = true;
    file = next;
    index = direction === 'next' ? 0 : stopCounts[file] - 1;
    if (remaining === 0) return { file, index };
  }
}

/** The height of a rendered diff row inside `root` (shadow roots included), or `fallback`. */
export function renderedRowHeight(root: ParentNode, searchRoots: (root: ParentNode) => ParentNode[], fallback = 20): number {
  for (const searchRoot of searchRoots(root)) {
    const el = searchRoot.querySelector?.('[data-line-type][data-line-index]');
    const height = el?.getBoundingClientRect().height ?? 0;
    if (height > 0) return height;
  }
  return fallback;
}

/**
 * A move of `count` stops. It stops on the file's first or last stop rather
 * than leaving the file part-way; from that stop, the next one goes on to the
 * next (or previous) file, as `J` / `K` do.
 */
export function stepCursorBy(
  stopCount: number,
  current: number | null,
  direction: 'next' | 'prev',
  count: number,
  fallback: number | null = null,
): CursorStep {
  if (count <= 1 || current == null) return stepCursor(stopCount, current, direction, fallback);
  if (direction === 'next') {
    if (current >= stopCount - 1) return { edge: 'end' };
    return { index: Math.min(stopCount - 1, current + count) };
  }
  if (current <= 0) return { edge: 'start' };
  return { index: Math.max(0, current - count) };
}

function isInsideOrigin(event: KeyboardEvent, selector: string): boolean {
  const origin = (event.composedPath?.()[0] ?? event.target) as Element | null;
  if (!origin || typeof (origin as Element).closest !== 'function') return false;
  return !!origin.closest(selector);
}

function isInteractiveOrigin(event: KeyboardEvent): boolean {
  return isInsideOrigin(event, 'button, a[href], summary, select, [role="button"], [role="tab"], [role="treeitem"], [role="option"], [role="menuitem"], [role="link"], [role="checkbox"], [role="switch"]');
}

/**
 * Where the composer opens for the keyboard: just under the row (or comment)
 * it is for, rather than at the last pointer position. The composer centres
 * itself on `left`, so it is kept far enough inside the view for its whole
 * width (about 340 px) to stay over the diff.
 */
const COMPOSER_HALF_WIDTH = 170;

export function composerPositionFor(rect: { bottom: number } | null, view: { top: number; left: number; width: number; height: number }): { top: number; left: number } {
  const left = view.left + Math.max(Math.min(view.width / 2, COMPOSER_HALF_WIDTH + 40), Math.min(COMPOSER_HALF_WIDTH, view.width / 2));
  if (!rect) return { top: view.top + view.height / 2, left };
  const top = Math.min(Math.max(rect.bottom + 6, view.top + 8), view.top + view.height - 8);
  return { top, left };
}

/**
 * The file a `J` / `K` at a file's edge enters, and the stop it lands on
 * there. Single-file view: the next diff tab mounts and takes it. A request
 * no view took within a few seconds is dropped, so a later visit to that
 * file does not jump.
 */
const ENTRY_TTL_MS = 3000;
let pendingEntry: { filePath: string; at: 'first' | 'last'; time: number } | null = null;

export function requestCursorEntry(filePath: string, at: 'first' | 'last', now = Date.now()): void {
  pendingEntry = { filePath, at, time: now };
}

export function takeCursorEntry(filePath: string, now = Date.now()): 'first' | 'last' | null {
  if (!pendingEntry || pendingEntry.filePath !== filePath) return null;
  const { at, time } = pendingEntry;
  pendingEntry = null;
  return now - time <= ENTRY_TTL_MS ? at : null;
}
