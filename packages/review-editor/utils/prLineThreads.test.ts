/**
 * Where a PR's existing review threads land on the review diff. What regresses: a thread drawn on the wrong line or
 * the wrong side (a removed line's thread under an added line with the same number); a thread on a context line lost
 * because the forge numbered it on the old side; a thread whose line the diff does not draw silently dropped instead
 * of shown at the top of its file; a removed-line thread placed in Whole stack, whose base is another branch; a thread
 * on a whole file drawn on a line.
 */
import { describe, expect, test } from 'bun:test';
import type { PRReviewThread } from '@plannotator/shared/pr-types';
import { placePRThreads, placedPRThreadKey, prThreadFoldedWhy } from './prLineThreads';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,4 +10,4 @@',
  ' keep10',
  '-old11',
  '+new11',
  ' keep12',
  ' keep13',
  '',
].join('\n');

const DELETED = [
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
  '',
].join('\n');

const files = [
  { path: 'src/a.ts', patch: PATCH },
  { path: 'gone.ts', patch: DELETED },
];

let n = 0;
function thread(over: Partial<PRReviewThread>): PRReviewThread {
  n += 1;
  return {
    id: `t${n}`,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 11,
    startLine: null,
    diffSide: 'RIGHT',
    comments: [{ id: `c${n}`, author: 'mona', body: 'Hm', createdAt: '2026-11-01T00:00:00Z', url: 'https://x/c' }],
    ...over,
  };
}

const place = (t: PRReviewThread, scope?: 'layer' | 'full-stack') => {
  const [placed] = placePRThreads([t], files, scope);
  return placed && { line: placed.line, side: placed.side, where: placed.where };
};

describe('placePRThreads', () => {
  test('an added line and a removed line with the same number land on their own sides', () => {
    expect(place(thread({ line: 11, diffSide: 'RIGHT' }))).toEqual({ line: 11, side: 'new', where: 'line' });
    expect(place(thread({ line: 11, diffSide: 'LEFT' }))).toEqual({ line: 11, side: 'old', where: 'line' });
  });

  test('a thread on a context line numbered on the old side is drawn on that line', () => {
    // Old 12 is the context line drawn as new 12.
    expect(place(thread({ line: 12, diffSide: 'LEFT' }))).toEqual({ line: 12, side: 'new', where: 'line' });
  });

  test('a line the diff does not draw puts the thread at the top of its file, saying why', () => {
    expect(place(thread({ line: 200 }))).toEqual({ line: 10, side: 'new', where: 'elsewhere' });
    expect(place(thread({ line: null, isOutdated: true }))).toEqual({ line: 10, side: 'new', where: 'outdated' });
  });

  test('Whole stack draws no removed-line thread on its line', () => {
    expect(place(thread({ line: 11, diffSide: 'LEFT' }), 'full-stack')).toEqual({ line: 10, side: 'new', where: 'elsewhere' });
    expect(place(thread({ line: 11, diffSide: 'RIGHT' }), 'full-stack')).toEqual({ line: 11, side: 'new', where: 'line' });
  });

  test('a thread on a whole file goes above the first hunk, on the side the file has', () => {
    expect(place(thread({ line: null }))).toEqual({ line: 0, side: 'new', where: 'file' });
    expect(place(thread({ path: 'gone.ts', line: null }))).toEqual({ line: 0, side: 'old', where: 'file' });
  });

  test('a thread on a file this diff does not change, or with no comments, is not drawn', () => {
    expect(placePRThreads([thread({ path: 'other.ts' }), thread({ comments: [] })], files, 'layer')).toEqual([]);
  });
});

describe('thread folding and keys', () => {
  test('resolved and bots-only threads start folded; a person speaking keeps it open', () => {
    expect(prThreadFoldedWhy(thread({ isResolved: true }))).toBe('resolved');
    const bot = { id: 'b', author: 'ci[bot]', isBot: true, body: 'x', createdAt: '', url: '' };
    expect(prThreadFoldedWhy(thread({ comments: [bot] }))).toBe('bot');
    expect(prThreadFoldedWhy(thread({ comments: [bot, { ...bot, id: 'p', author: 'mona', isBot: false }] }))).toBeNull();
  });

  test('a new reply or a resolve changes the key, so the diff draws the thread again', () => {
    const t = thread({});
    const [before] = placePRThreads([t], files, 'layer');
    const [replied] = placePRThreads([{ ...t, comments: [...t.comments, { ...t.comments[0]!, id: 'r', body: 'Fixed' }] }], files, 'layer');
    const [resolved] = placePRThreads([{ ...t, isResolved: true }], files, 'layer');
    const [same] = placePRThreads([{ ...t }], files, 'layer');
    expect(placedPRThreadKey(replied!)).not.toBe(placedPRThreadKey(before!));
    expect(placedPRThreadKey(resolved!)).not.toBe(placedPRThreadKey(before!));
    expect(placedPRThreadKey(same!)).toBe(placedPRThreadKey(before!));
  });
});
