import { defineShortcutScope } from '../core';

/**
 * The diff line cursor (single-file and All files views). The views handle
 * the keys themselves, as they do `N`; this scope is what the shortcut map
 * and the docs list.
 */
export const reviewLineCursorShortcuts = defineShortcutScope({
  id: 'review-line-cursor',
  title: 'Line Cursor',
  shortcuts: {
    moveDown: {
      description: 'Next line or comment',
      bindings: ['J'],
      section: 'Line Cursor',
      hint: 'Stops on each of your comments under a line. Past the last line of a file, goes on to the next file.',
      displayOrder: 10,
    },
    moveUp: {
      description: 'Previous line or comment',
      bindings: ['K'],
      section: 'Line Cursor',
      hint: 'Before the first line of a file, goes back to the previous file.',
      displayOrder: 20,
    },
    halfPageDown: {
      description: 'Half a view down',
      bindings: ['Ctrl+D'],
      section: 'Line Cursor',
      hint: 'The Control key on every system, as in Vim. All files carries on into the next file; a single file stops on its last line, and from there goes on to the next file.',
      displayOrder: 22,
    },
    halfPageUp: {
      description: 'Half a view up',
      bindings: ['Ctrl+U'],
      section: 'Line Cursor',
      hint: 'All files carries on into the previous file; a single file stops on its first line first.',
      displayOrder: 24,
    },
    comment: {
      description: 'Comment on the line, or edit the comment',
      bindings: ['I', 'Enter'],
      section: 'Line Cursor',
      hint: 'On a line: opens a new comment. On a comment: opens it for editing.',
      displayOrder: 30,
    },
    saveAndClose: {
      description: 'Save the comment and close',
      bindings: ['Escape'],
      section: 'Line Cursor',
      hint: 'In a comment opened with I or Enter. An empty one just closes.',
      displayOrder: 40,
    },
  },
});
