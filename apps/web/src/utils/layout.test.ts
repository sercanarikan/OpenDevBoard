import { describe, it, expect } from 'vitest';
import {
  SIDEBAR_AUTO_COLLAPSE_WIDTH,
  hasMoreToRight,
  kanbanScopeSplit,
  parseSidebarPref,
  resolveSidebarCollapsed
} from './layout';

describe('kanban scope split', () => {
  it('separates active cards from the completed column', () => {
    expect(kanbanScopeSplit(10, 3)).toEqual({ active: 7, done: 3 });
    expect(kanbanScopeSplit(5, 0)).toEqual({ active: 5, done: 0 });
    expect(kanbanScopeSplit(0, 0)).toEqual({ active: 0, done: 0 });
  });
});

describe('horizontal scroll cue', () => {
  it('reports content to the right until the scroll end', () => {
    expect(hasMoreToRight(0, 400, 1200)).toBe(true);
    expect(hasMoreToRight(800, 400, 1200)).toBe(false);
    expect(hasMoreToRight(799.5, 400, 1200)).toBe(false);
    expect(hasMoreToRight(0, 400, 400)).toBe(false);
  });
});

describe('sidebar preference', () => {
  it('parses only the two known values', () => {
    expect(parseSidebarPref('collapsed')).toBe('collapsed');
    expect(parseSidebarPref('expanded')).toBe('expanded');
    expect(parseSidebarPref('weird')).toBeNull();
    expect(parseSidebarPref(null)).toBeNull();
  });

  it('auto-collapses below the breakpoint and expands at or above it', () => {
    expect(resolveSidebarCollapsed(null, 1024)).toBe(true);
    expect(resolveSidebarCollapsed(null, SIDEBAR_AUTO_COLLAPSE_WIDTH - 1)).toBe(true);
    expect(resolveSidebarCollapsed(null, SIDEBAR_AUTO_COLLAPSE_WIDTH)).toBe(false);
    expect(resolveSidebarCollapsed(null, 1920)).toBe(false);
  });

  it('an explicit choice wins over the viewport width', () => {
    expect(resolveSidebarCollapsed('expanded', 1024)).toBe(false);
    expect(resolveSidebarCollapsed('collapsed', 1920)).toBe(true);
  });
});
