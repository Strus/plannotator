/**
 * A PR's existing review thread, drawn in the diff under the line it is about (a `HostLineNote`). It can be resolved
 * or unresolved here, as on the forge; to reply, it links to the forge. Never an annotation: nothing here is counted,
 * exported or posted with the reviewer's own comments.
 *
 * An open thread shows every comment, or its first and last with "N more" between; a long comment stops after a few
 * lines with "Show all". A resolved thread, one where only bots speak, and a thread on a whole file start as one line
 * that opens in place. A comment the forge hides is one line too.
 */
import React, { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CircleCheck, ChevronDown, ChevronRight, ExternalLink, MessageSquare, RotateCcw } from 'lucide-react';
import type { PRReviewThread, PRThreadComment } from '@plannotator/shared/pr-types';
import { usePRThreadBusy, type PRThreadBusy } from '../hooks/usePRThreadResolve';
import { Avatar } from './Avatar';
import { MarkdownBody } from './MarkdownBody';
import { BotTag, formatRelativeTime } from './prCommentBits';
import { prThreadFoldedWhy, shownThreadComments, type PlacedPRThread } from '../utils/prLineThreads';

/**
 * What the reviewer opened or folded, per thread, for the page's life: the diff draws a line again when it scrolls
 * back or a read brings news, and a thread they opened stays open.
 */
export class PRThreadMemory {
  private kept = new Map<string, boolean>();
  private listeners = new Set<() => void>();
  get(key: string): boolean | undefined {
    return this.kept.get(key);
  }
  set(key: string, value: boolean): void {
    this.kept.set(key, value);
    for (const listener of this.listeners) listener();
  }
  /** Back to how the thread starts for what it shows now. */
  forget(key: string): void {
    if (!this.kept.delete(key)) return;
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

function useRemembered(memory: PRThreadMemory, key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const read = () => memory.get(key);
  const value = useSyncExternalStore(memory.subscribe, read, read);
  return [value ?? initial, (next) => memory.set(key, next)];
}

export interface PRLineThreadProps {
  placed: PlacedPRThread;
  memory: PRThreadMemory;
  /** "GitHub", "GitLab", "Bitbucket". */
  forge: string;
  /** GitHub attachment images load through the proxy (`proxiesGitHubImages`). */
  authenticatedImages: boolean;
  /** Resolve or unresolve the thread on the forge. Absent: no button. */
  onSetResolved?: (threadId: string, resolved: boolean) => void;
  busy?: PRThreadBusy;
}

/** The signed-in person may flip this thread's resolved state, as far as the forge says. */
export function canToggleResolved(thread: PRReviewThread): boolean {
  return thread.isResolved ? thread.viewerCanUnresolve !== false : thread.viewerCanResolve !== false;
}

/** "Resolve conversation" / "Unresolve conversation", as on GitHub. */
export function ResolveThreadButton({ thread, busy, onSetResolved, className = 'text-[11px]' }: {
  thread: PRReviewThread;
  busy?: PRThreadBusy;
  onSetResolved: (threadId: string, resolved: boolean) => void;
  className?: string;
}) {
  const pending = usePRThreadBusy(busy, thread.id);
  if (!canToggleResolved(thread)) return null;
  const Icon = thread.isResolved ? RotateCcw : CircleCheck;
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-50 disabled:pointer-events-none transition-colors ${className}`}
      disabled={pending}
      aria-busy={pending || undefined}
      data-pr-thread-resolve={thread.isResolved ? 'unresolve' : 'resolve'}
      onClick={(event) => {
        event.stopPropagation();
        onSetResolved(thread.id, !thread.isResolved);
      }}
    >
      <Icon aria-hidden="true" size={12} />
      {thread.isResolved ? 'Unresolve conversation' : 'Resolve conversation'}
    </button>
  );
}

const firstLine = (text: string) =>
  text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map((row) => row.replace(/^\s*(?:[#>*-]+\s*)+/, '').replace(/[`*_]/g, '').trim())
    .find(Boolean) ?? '';

const WHERE_WORDS: Record<PlacedPRThread['where'], string | null> = {
  line: null,
  file: 'On this file',
  outdated: 'Outdated: a later push changed its lines',
  elsewhere: 'On a line this diff does not show',
};

const FOLD_WORDS = { resolved: 'Resolved', bot: 'Bots only' } as const;

function Author({ comment, size = 20 }: { comment: PRThreadComment; size?: number }) {
  return (
    <>
      <Avatar src={comment.avatarUrl} name={comment.author} size={size} />
      <span className="text-[12px] font-semibold text-foreground truncate max-w-[14rem]" title={comment.author || undefined}>
        {comment.author || 'unknown'}
      </span>
      {comment.isBot && <BotTag />}
    </>
  );
}

/** A comment's words; a long one stops after a few lines and says "Show all". */
function Words({ comment, memory, authenticatedImages }: { comment: PRThreadComment; memory: PRThreadMemory; authenticatedImages: boolean }) {
  const [all, setAll] = useRemembered(memory, `all:${comment.id}`, false);
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || all) return;
    const measure = () => setTall(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [all, comment.body]);
  return (
    <>
      <div ref={box} className={`review-comment-markdown leading-relaxed text-foreground/85 ${all ? '' : 'max-h-40 overflow-hidden'}`}>
        <MarkdownBody prMedia authenticatedImages={authenticatedImages} markdown={comment.body} textClassName="text-[13px]" />
      </div>
      {(tall || all) && (
        <button type="button" className="mt-0.5 text-[11px] text-primary/80 hover:text-primary" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}

function OneComment({ comment, memory, forge, authenticatedImages, link }: {
  comment: PRThreadComment;
  memory: PRThreadMemory;
  forge: string;
  authenticatedImages: boolean;
  link?: React.ReactNode;
}) {
  const [shown, setShown] = useRemembered(memory, `hidden:${comment.id}`, false);
  const hiddenWhy = comment.minimizedReason ? ` as ${comment.minimizedReason.toLowerCase().replace(/[_-]/g, ' ')}` : '';
  return (
    <div className="py-1.5" data-pr-thread-comment={comment.id}>
      <div className="flex items-center gap-1.5 min-w-0">
        <Author comment={comment} />
        <span className="text-[10px] text-muted-foreground shrink-0">{formatRelativeTime(comment.createdAt)}</span>
        {link}
      </div>
      <div className="mt-1 pl-[26px]">
        {comment.isMinimized && !shown ? (
          <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShown(true)}>
            {`Hidden on ${forge}${hiddenWhy}. Show`}
          </button>
        ) : (
          <Words comment={comment} memory={memory} authenticatedImages={authenticatedImages} />
        )}
      </div>
    </div>
  );
}

/** One line for a folded thread: who started it, their first words, how many, and why it is folded. */
function FoldedLine({ placed, forge }: { placed: PlacedPRThread; forge: string }) {
  const { thread, where } = placed;
  const first = thread.comments[0]!;
  const count = thread.comments.length;
  const why = prThreadFoldedWhy(thread);
  return (
    <>
      <ChevronRight aria-hidden="true" size={13} className="shrink-0 text-muted-foreground/70" />
      {where === 'file' && (
        <span className="inline-flex items-center gap-1 shrink-0 text-[11px] text-muted-foreground">
          <MessageSquare aria-hidden="true" size={12} />
          On this file ·
        </span>
      )}
      <Author comment={first} size={18} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
        {first.isMinimized ? `Hidden on ${forge}` : firstLine(first.body)}
      </span>
      {count > 1 && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" aria-label={`${count} comments`}>{count}</span>}
      {why && <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{FOLD_WORDS[why]}</span>}
      {where === 'outdated' && <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-warning/15 text-warning">Outdated</span>}
    </>
  );
}

export function PRLineThread({ placed, memory, forge, authenticatedImages, onSetResolved, busy }: PRLineThreadProps) {
  const { thread, where } = placed;
  const why = prThreadFoldedWhy(thread);
  const [open, setOpen] = useRemembered(memory, `open:${thread.id}`, why === null && where !== 'file');
  const [whole, setWhole] = useRemembered(memory, `whole:${thread.id}`, false);
  const first = thread.comments[0];
  if (!first) return null;
  const common = {
    'data-pr-thread': thread.id,
    'data-pr-thread-where': where,
    'data-pr-thread-resolved': thread.isResolved ? '' : undefined,
  };
  const frame = 'pr-line-thread font-sans whitespace-normal mx-2 my-1.5 rounded-md border border-border/50 bg-card text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)]';
  if (!open) {
    return (
      <button
        type="button"
        className={`${frame} flex w-[calc(100%-1rem)] items-center gap-1.5 px-2.5 py-1.5 hover:border-border transition-colors`}
        aria-expanded={false}
        onClick={() => setOpen(true)}
        title={`Open this ${forge} thread`}
        {...common}
      >
        <FoldedLine placed={placed} forge={forge} />
      </button>
    );
  }
  const whereWords = WHERE_WORDS[where];
  const span = where === 'line' && thread.startLine !== null && thread.line !== null && thread.startLine !== thread.line
    ? `Lines ${thread.startLine}–${thread.line}`
    : null;
  const { shown, between } = shownThreadComments(thread.comments, whole);
  const link = first.url ? (
    <a
      className="ml-auto shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground"
      href={first.url}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open on ${forge} to reply`}
      aria-label={`Open this thread on ${forge}`}
    >
      <ExternalLink aria-hidden="true" size={13} />
    </a>
  ) : null;
  return (
    <div className={`${frame} px-2.5 py-1`} data-open="" {...common}>
      <div className="flex items-center gap-2 pt-0.5 text-[11px] text-muted-foreground">
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground"
          aria-expanded
          onClick={() => setOpen(false)}
          title="Fold this thread"
        >
          <ChevronDown aria-hidden="true" size={13} />
          <MessageSquare aria-hidden="true" size={12} />
          {thread.comments.length === 1 ? '1 comment' : `${thread.comments.length} comments`}
        </button>
        {why && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted">{FOLD_WORDS[why]}</span>}
        {whereWords && <span>{whereWords}</span>}
        {!whereWords && thread.isOutdated && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-warning/15 text-warning">Outdated</span>}
        {span && <span>{span}</span>}
        {onSetResolved && (
          <ResolveThreadButton
            thread={thread}
            busy={busy}
            className="ml-auto -mr-1 text-[11px]"
            onSetResolved={(threadId, resolved) => {
              // As on GitHub, a resolved conversation folds away (and opens again if the forge refuses); an
              // unresolved one stays open.
              if (resolved) memory.forget(`open:${threadId}`);
              else setOpen(true);
              onSetResolved(threadId, resolved);
            }}
          />
        )}
      </div>
      <div className="divide-y divide-border/30">
        {shown.map((comment, index) => (
          <React.Fragment key={comment.id}>
            <OneComment
              comment={comment}
              memory={memory}
              forge={forge}
              authenticatedImages={authenticatedImages}
              link={index === 0 ? link : undefined}
            />
            {between > 0 && index === 0 && (
              <button type="button" className="block w-full py-1 text-left text-[11px] text-primary/80 hover:text-primary" onClick={() => setWhole(true)}>
                {between} more
              </button>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
