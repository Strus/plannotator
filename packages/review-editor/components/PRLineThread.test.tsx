/**
 * A PR thread drawn on the diff. What regresses: a resolved thread drawn open and taking the diff's space; a thread
 * the reviewer opened folding again when the diff redraws its line (scrolling back, a new read); a long thread losing
 * its last comment; a hidden comment's words shown without asking; a thread with no way to reply on the forge; a
 * Resolve button for someone the forge would refuse.
 */
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PRReviewThread, PRThreadComment } from '@plannotator/shared/pr-types';
import { PRLineThread, PRThreadMemory } from './PRLineThread';
import type { PlacedPRThread } from '../utils/prLineThreads';

const comment = (id: string, body: string, over: Partial<PRThreadComment> = {}): PRThreadComment => ({
  id, author: 'mona', body, createdAt: '2026-11-01T00:00:00Z', url: `https://github.com/o/r/pull/1#discussion_${id}`, ...over,
});

const placed = (over: Partial<PRReviewThread> = {}, where: PlacedPRThread['where'] = 'line'): PlacedPRThread => ({
  thread: {
    id: 'T1', isResolved: false, isOutdated: false, path: 'a.ts', line: 3, startLine: null, diffSide: 'RIGHT',
    comments: [comment('c1', 'Rename this?')], ...over,
  },
  filePath: 'a.ts', line: 3, side: 'new', where,
});

const draw = (p: PlacedPRThread, memory = new PRThreadMemory()) =>
  renderToStaticMarkup(<PRLineThread placed={p} memory={memory} forge="GitHub" authenticatedImages={false} />);

describe('PRLineThread', () => {
  test('an open thread shows its words and links to the forge to reply', () => {
    const html = draw(placed());
    expect(html).toContain('data-open=""');
    expect(html).toContain('Rename this?');
    expect(html).toContain('href="https://github.com/o/r/pull/1#discussion_c1"');
  });

  test('a resolved thread starts as one line, and stays open once the reviewer opens it', () => {
    const p = placed({ isResolved: true });
    const memory = new PRThreadMemory();
    const folded = draw(p, memory);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain('Resolved');
    expect(folded).not.toContain('data-open');
    memory.set('open:T1', true);
    expect(draw(p, memory)).toContain('data-open=""');
  });

  test('a thread on a whole file starts folded even when unresolved', () => {
    expect(draw(placed({ line: null }, 'file'))).toContain('On this file');
    expect(draw(placed({ line: null }, 'file'))).not.toContain('data-open');
  });

  test('a long thread shows its first and last comment and how many between', () => {
    const comments = ['first', 'two', 'three', 'four', 'last'].map((body, i) => comment(`c${i}`, body));
    const html = draw(placed({ comments }));
    expect(html).toContain('first');
    expect(html).toContain('last');
    expect(html).not.toContain('>three<');
    expect(html).toContain('3 more');
  });

  test('an open thread offers Resolve, Unresolve once resolved, and neither when the forge says the viewer may not', () => {
    const resolvable = (over: Partial<PRReviewThread>) => {
      const memory = new PRThreadMemory();
      memory.set('open:T1', true);
      return renderToStaticMarkup(
        <PRLineThread placed={placed(over)} memory={memory} forge="GitHub" authenticatedImages={false} onSetResolved={() => {}} />,
      );
    };
    expect(resolvable({})).toContain('data-pr-thread-resolve="resolve"');
    expect(resolvable({ isResolved: true })).toContain('data-pr-thread-resolve="unresolve"');
    expect(resolvable({ viewerCanResolve: false })).not.toContain('data-pr-thread-resolve=');
    expect(resolvable({ isResolved: true, viewerCanUnresolve: false })).not.toContain('data-pr-thread-resolve=');
  });

  test('a comment the forge hides is not shown until asked', () => {
    const html = draw(placed({ comments: [comment('c1', 'Rename this?'), comment('c2', 'spam words', { isMinimized: true, minimizedReason: 'SPAM' })] }));
    expect(html).toContain('Hidden on GitHub as spam. Show');
    expect(html).not.toContain('spam words');
  });
});
