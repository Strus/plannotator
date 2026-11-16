import React from 'react';

/** Small muted "bot" tag shown next to automation-account authors. */
export function BotTag() {
  return (
    <span className="shrink-0 text-xs font-semibold px-1 py-px rounded bg-muted text-muted-foreground/70">
      bot
    </span>
  );
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
