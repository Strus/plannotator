/**
 * Where the PR's existing review threads (teammates', bots', the reviewer's own earlier ones) go on the review diff:
 * each under the line it is about when the diff on screen draws that line; one whose line the diff does not draw (a
 * push moved past it, or Whole stack starts from another base) at the top of its file, saying why. A thread on a whole
 * file sits above the file's first hunk. A thread on a file the diff does not change is not drawn (the PR panel's
 * Comments tab still lists it). The same rules as the Inbox's PR page (`packages/inbox/pulls/threadPlaces.ts`).
 */
import { diffHunkLines } from '@plannotator/core/diff-files';
import type { PRDiffScope, PRReviewThread } from '@plannotator/shared/pr-types';

/** Why a thread sits where it does. */
export type PRThreadWhere = 'line' | 'outdated' | 'elsewhere' | 'file';

export interface PlacedPRThread {
  thread: PRReviewThread;
  filePath: string;
  /** The line it is drawn under, on `side`; 0 for above the file's first hunk. */
  line: number;
  side: 'old' | 'new';
  where: PRThreadWhere;
}

interface DrawnLines {
  /** Old-side line -> where Pierre draws it: a context line is drawn on its new side. */
  old: Map<number, { line: number; side: 'old' | 'new' }>;
  new: Set<number>;
  first: { line: number; side: 'old' | 'new' } | null;
}

/** The lines one file's patch draws, on each side, and the first one. Null when the patch cannot be read. */
export function drawnPatchLines(patch: string): DrawnLines | null {
  const hunks = diffHunkLines(patch);
  if (!hunks) return null;
  const out: DrawnLines = { old: new Map(), new: new Set(), first: null };
  let firstOld: number | null = null;
  for (const hunk of hunks) {
    for (const row of hunk.lines) {
      if (row.kind === 'add') {
        out.new.add(row.newLine);
        out.first ??= { line: row.newLine, side: 'new' };
      } else if (row.kind === 'del') {
        out.old.set(row.oldLine, { line: row.oldLine, side: 'old' });
        firstOld ??= row.oldLine;
      } else {
        out.new.add(row.newLine);
        out.old.set(row.oldLine, { line: row.newLine, side: 'new' });
        out.first ??= { line: row.newLine, side: 'new' };
      }
    }
  }
  // A deleted file draws only removed lines.
  if (!out.first && firstOld !== null) out.first = { line: firstOld, side: 'old' };
  return out;
}

/**
 * Every thread this diff can draw, in the forge's order. `scope` is the PR diff on screen: Whole stack runs from the
 * stack's base, so a thread on a removed line (this PR's base) has no line there.
 */
export function placePRThreads(
  threads: readonly PRReviewThread[],
  files: readonly { path: string; patch: string }[],
  scope: PRDiffScope | undefined,
): PlacedPRThread[] {
  const byPath = new Map(files.map((file) => [file.path, file.patch]));
  const drawnByPath = new Map<string, DrawnLines | null>();
  const placed: PlacedPRThread[] = [];
  for (const thread of threads) {
    if (thread.comments.length === 0) continue;
    const patch = byPath.get(thread.path);
    if (patch === undefined) continue;
    let drawn = drawnByPath.get(thread.path);
    if (drawn === undefined) drawnByPath.set(thread.path, (drawn = drawnPatchLines(patch)));
    if (!drawn?.first) continue;
    const base = { thread, filePath: thread.path };
    if (thread.line === null && !thread.isOutdated) {
      placed.push({ ...base, line: 0, side: drawn.first.side, where: 'file' });
      continue;
    }
    const side = thread.diffSide === 'LEFT' ? 'old' : 'new';
    if (thread.line !== null) {
      if (side === 'new' && drawn.new.has(thread.line)) {
        placed.push({ ...base, line: thread.line, side: 'new', where: 'line' });
        continue;
      }
      const old = side === 'old' && scope !== 'full-stack' ? drawn.old.get(thread.line) : undefined;
      if (old) {
        placed.push({ ...base, ...old, where: 'line' });
        continue;
      }
    }
    placed.push({ ...base, ...drawn.first, where: thread.isOutdated ? 'outdated' : 'elsewhere' });
  }
  return placed;
}

/** Why a thread starts folded to one line, or null when it starts open. A thread on a whole file always starts folded. */
export function prThreadFoldedWhy(thread: PRReviewThread): 'resolved' | 'bot' | null {
  if (thread.isResolved) return 'resolved';
  if (thread.comments.every((comment) => comment.isBot)) return 'bot';
  return null;
}

/** A thread longer than this shows its first and last comments, and how many between. */
export const PR_THREAD_SHOWN_MAX = 3;

export function shownThreadComments<T>(comments: readonly T[], whole: boolean): { shown: T[]; between: number } {
  if (whole || comments.length <= PR_THREAD_SHOWN_MAX) return { shown: [...comments], between: 0 };
  return { shown: [comments[0]!, comments[comments.length - 1]!], between: comments.length - 2 };
}

function wordsHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** What a placed thread draws, as a key: the same key, the diff leaves the line as it is. */
export function placedPRThreadKey(placed: PlacedPRThread): string {
  const { thread } = placed;
  return [
    placed.where,
    thread.isResolved ? 'r' : '',
    thread.isOutdated ? 'o' : '',
    thread.startLine ?? '',
    thread.line ?? '',
    ...thread.comments.map((c) => `${c.id}:${c.author}:${c.createdAt}:${c.isMinimized ? 'h' : ''}:${wordsHash(c.body)}`),
  ].join('|');
}
