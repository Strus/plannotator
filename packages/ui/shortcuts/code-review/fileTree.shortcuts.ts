import { defineShortcutScope } from '../core';

export const reviewFileTreeShortcuts = defineShortcutScope({
  id: 'review-file-tree',
  title: 'File Navigation',
  shortcuts: {
    nextFile: {
      description: 'Next file',
      bindings: ['J', 'ArrowDown'],
      section: 'File Navigation',
      hint: 'While a diff is shown, J moves the line cursor instead (it goes on to the next file at the end of one).',
      displayOrder: 10,
    },
    prevFile: {
      description: 'Previous file',
      bindings: ['K', 'ArrowUp'],
      section: 'File Navigation',
      hint: 'While a diff is shown, K moves the line cursor instead.',
      displayOrder: 20,
    },
    firstFile: {
      description: 'First file',
      bindings: ['Home'],
      section: 'File Navigation',
      displayOrder: 30,
    },
    lastFile: {
      description: 'Last file',
      bindings: ['End'],
      section: 'File Navigation',
      displayOrder: 40,
    },
  },
});

