/**
 * Resolving one of the PR's review threads from the review app, as the forge's "Resolve conversation" button does
 * (`POST /api/pr-thread-resolve`). The thread shows its new state at once; the forge's refusal puts it back and says
 * why. A wish lasts until the PR context read from the forge shows it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PRContext } from '@plannotator/shared/pr-types';
import { noteServerSessionMismatch, withServerSession } from '@plannotator/ui/utils/serverSession';
/** Thread id to the resolved state the reviewer asked for. */
export type PRThreadWishes = ReadonlyMap<string, boolean>;

const NO_WISHES: PRThreadWishes = new Map();

/** The context with each wished thread shown resolved or not; the same object when nothing changes. */
export function applyPRThreadWishes(context: PRContext | null, wishes: PRThreadWishes): PRContext | null {
  if (!context || wishes.size === 0) return context;
  let changed = false;
  const reviewThreads = context.reviewThreads.map((thread) => {
    const wish = wishes.get(thread.id);
    if (wish === undefined || wish === thread.isResolved) return thread;
    changed = true;
    return { ...thread, isResolved: wish };
  });
  return changed ? { ...context, reviewThreads } : context;
}

/** The wishes the forge's context does not show yet; the same map when none came true. */
export function pendingPRThreadWishes(context: PRContext | null, wishes: PRThreadWishes): PRThreadWishes {
  if (!context || wishes.size === 0) return wishes;
  const shown = new Map(context.reviewThreads.map((thread) => [thread.id, thread.isResolved]));
  const left = new Map([...wishes].filter(([id, resolved]) => shown.get(id) !== resolved));
  return left.size === wishes.size ? wishes : left;
}

const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

/**
 * The threads whose change the forge has not answered yet. A store of its own, not state: the diff draws a thread
 * again only when what it shows changes (`placedPRThreadKey`), so the card reads this itself.
 */
export class PRThreadBusy {
  private ids = new Set<string>();
  private listeners = new Set<() => void>();
  has = (threadId: string): boolean => this.ids.has(threadId);
  set(threadId: string, busy: boolean): void {
    if (this.ids.has(threadId) === busy) return;
    if (busy) this.ids.add(threadId);
    else this.ids.delete(threadId);
    for (const listener of this.listeners) listener();
  }
  clear(): void {
    for (const id of [...this.ids]) this.set(id, false);
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** Whether a change to this thread is on its way to the forge. */
export function usePRThreadBusy(busy: PRThreadBusy | undefined, threadId: string): boolean {
  return useSyncExternalStore(
    busy?.subscribe ?? noSubscribe,
    () => busy?.has(threadId) ?? false,
    () => false,
  );
}

const noSubscribe = () => () => {};

export interface PRThreadResolveState {
  /** The PR context with the reviewer's own resolves shown. */
  prContext: PRContext | null;
  setThreadResolved: (threadId: string, resolved: boolean) => void;
  busy: PRThreadBusy;
}

export function usePRThreadResolve(
  raw: PRContext | null,
  prUrl: string | undefined,
  onError: (message: string) => void,
  fetchImpl: typeof fetch = fetch,
): PRThreadResolveState {
  const [wishes, setWishes] = useState<PRThreadWishes>(NO_WISHES);
  const busy = useRef(new PRThreadBusy()).current;
  const urlRef = useRef(prUrl);
  urlRef.current = prUrl;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    setWishes(NO_WISHES);
    busy.clear();
  }, [prUrl, busy]);
  useEffect(() => {
    setWishes((current) => pendingPRThreadWishes(raw, current));
  }, [raw]);

  const setThreadResolved = useCallback((threadId: string, resolved: boolean) => {
    const url = urlRef.current;
    if (!url || busy.has(threadId)) return;
    setWishes((current) => new Map(current).set(threadId, resolved));
    busy.set(threadId, true);
    void (async () => {
      let error: string | null = null;
      try {
        const res = await fetchImpl('/api/pr-thread-resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(withServerSession({ threadId, resolved, prUrl: url })),
        });
        if (!res.ok) {
          // A replaced server shows its own reload prompt: no second message.
          const replaced = await noteServerSessionMismatch(res);
          const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
          error = replaced ? '' : typeof data?.error === 'string' && data.error ? data.error : `HTTP ${res.status}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : 'Network error';
      }
      if (urlRef.current !== url) return;
      busy.set(threadId, false);
      if (error === null) return;
      setWishes((current) => (current.get(threadId) === resolved ? without(current, threadId) : current));
      if (error) onErrorRef.current(error);
    })();
  }, [fetchImpl, busy]);

  const prContext = useMemo(() => applyPRThreadWishes(raw, wishes), [raw, wishes]);
  return { prContext, setThreadResolved, busy };
}
