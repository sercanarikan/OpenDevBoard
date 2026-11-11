import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../types';
import type { KanbanLane, KanbanResponse } from '../types/paging';
import {
  INITIAL_KANBAN_STATE,
  cellId,
  composeBoard,
  kanbanReducer,
  mergeCards,
  mergeLanes,
  remainingCount,
  toListParams,
  type KanbanState
} from './useKanban';

const item = (id: number, state = 'Active'): WorkItem => ({ id, state, title: `#${id}` } as unknown as WorkItem);

const emptyColumns = () => ({ todo: [], 'in-progress': [], resolved: [], done: [] });

const lane = (key: string, overrides: Partial<KanbanLane> = {}): KanbanLane => ({
  id: `parent-${key}`,
  key,
  mode: 'parent',
  title: key,
  total: 0,
  counts: { todo: 0, 'in-progress': 0, resolved: 0, done: 0 },
  columns: emptyColumns(),
  ...overrides
});

const board = (lanes: KanbanLane[], extra: Partial<KanbanResponse> = {}): KanbanResponse => ({
  columns: { todo: 0, 'in-progress': 0, resolved: 0, done: 0 },
  total: 0,
  laneMode: 'parent',
  laneTotal: lanes.length,
  laneLimit: 25,
  laneOffset: 0,
  lanes,
  dataVersion: 'v1',
  ...extra
});

describe('mergeCards', () => {
  it('appends new cards after the existing ones, preserving order', () => {
    const merged = mergeCards([item(1), item(2)], [item(3), item(4)]);
    expect(merged.map(i => i.id)).toEqual([1, 2, 3, 4]);
  });

  it('drops cards whose id is already present (first occurrence wins)', () => {
    const first = item(2, 'Active');
    const dup = item(2, 'Resolved');
    const merged = mergeCards([item(1), first], [dup, item(3)]);
    expect(merged.map(i => i.id)).toEqual([1, 2, 3]);
    expect(merged[1]).toBe(first);
  });

  it('dedupes within a single batch as well', () => {
    expect(mergeCards([], [item(5), item(5), item(6)]).map(i => i.id)).toEqual([5, 6]);
  });
});

describe('mergeLanes', () => {
  it('appends lanes in server order and skips already-known keys', () => {
    const merged = mergeLanes([lane('1'), lane('2')], [lane('2'), lane('3'), lane('4')]);
    expect(merged.map(l => l.key)).toEqual(['1', '2', '3', '4']);
  });

  it('keeps the first lane object for a duplicated key', () => {
    const a = lane('7', { title: 'first' });
    const b = lane('7', { title: 'second' });
    expect(mergeLanes([a], [b])[0]).toBe(a);
  });
});

describe('remainingCount', () => {
  it('is the column total minus the cards already loaded', () => {
    expect(remainingCount(40, 15)).toBe(25);
    expect(remainingCount(15, 15)).toBe(0);
  });

  it('never goes negative (e.g. a shrunken column after a sync)', () => {
    expect(remainingCount(3, 15)).toBe(0);
  });
});

describe('composeBoard', () => {
  it('returns null without a board', () => {
    expect(composeBoard(null, [], {})).toBeNull();
  });

  it('appends continued cards only to the matching lane-column and keeps the server totals', () => {
    const l = lane('123', {
      total: 40,
      counts: { todo: 40, 'in-progress': 0, resolved: 0, done: 0 },
      columns: { ...emptyColumns(), todo: [item(1), item(2)] }
    });
    const other = lane('9', { columns: { ...emptyColumns(), todo: [item(9)] } });
    const extra = { [cellId('123', 'todo')]: [item(3)], [cellId('9', 'in-progress')]: [item(99)] };

    const composed = composeBoard(board([l, other], { total: 41 }), [], extra)!;

    expect(composed.lanes[0].columns.todo.map(i => i.id)).toEqual([1, 2, 3]);
    expect(composed.lanes[0].counts.todo).toBe(40);
    expect(composed.lanes[1].columns.todo.map(i => i.id)).toEqual([9]);
    expect(composed.lanes[1].columns['in-progress'].map(i => i.id)).toEqual([99]);
    expect(composed.lanes[1].columns.resolved).toEqual([]);
    expect(composed.total).toBe(41);
  });

  it('appends extra lanes after the server window, deduped by key', () => {
    const composed = composeBoard(board([lane('1')]), [lane('1'), lane('2')], {})!;
    expect(composed.lanes.map(l => l.key)).toEqual(['1', '2']);
  });

  it('does not mutate the server window', () => {
    const l = lane('1', { columns: { ...emptyColumns(), todo: [item(1)] } });
    const b = board([l]);
    composeBoard(b, [], { [cellId('1', 'todo')]: [item(2)] });
    expect(b.lanes[0].columns.todo.map(i => i.id)).toEqual([1]);
  });
});

describe('toListParams', () => {
  it('keeps only filter and sort fields for card continuation', () => {
    const params = toListParams({
      search: 'abc',
      project: 'Alpha',
      quickFilter: 'my-tasks',
      currentUser: 'Ada',
      sortBy: 'priority',
      sortOrder: 'asc',
      swimlane: 'parent',
      laneLimit: 25,
      cardLimit: 15,
      hideCompleted: true
    });
    expect(params).not.toHaveProperty('swimlane');
    expect(params).not.toHaveProperty('laneLimit');
    expect(params).not.toHaveProperty('cardLimit');
    expect(params).not.toHaveProperty('hideCompleted');
    expect(params).toMatchObject({ search: 'abc', project: 'Alpha', sortBy: 'priority', sortOrder: 'asc' });
  });
});

describe('kanbanReducer', () => {
  const started = (key: string): KanbanState => kanbanReducer(INITIAL_KANBAN_STATE, { type: 'boardStart', key });

  it('keeps the previous board visible while a reload runs', () => {
    const shown = kanbanReducer(started('a'), { type: 'boardSuccess', key: 'a', board: board([lane('1')]) });
    const reloading = kanbanReducer(shown, { type: 'boardStart', key: 'b' });
    expect(reloading.board).not.toBeNull();
    expect(reloading.loading).toBe(true);
  });

  it('ignores a response for a key that is no longer current (stale overwrite)', () => {
    const s = started('new');
    const after = kanbanReducer(s, { type: 'boardSuccess', key: 'old', board: board([lane('stale')]) });
    expect(after).toBe(s);
    expect(after.board).toBeNull();
  });

  it('ignores a stale error for an older key', () => {
    const s = started('new');
    expect(kanbanReducer(s, { type: 'boardError', key: 'old', message: 'x' }).error).toBeNull();
  });

  it('a new board replaces accumulated cards and lanes and sets the next lane offset', () => {
    let s = started('a');
    s = kanbanReducer(s, { type: 'boardSuccess', key: 'a', board: board([lane('1')], { laneTotal: 60 }) });
    s = kanbanReducer(s, { type: 'cellSuccess', key: 'a', cell: cellId('1', 'todo'), items: [item(5)] });
    expect(s.extraCards[cellId('1', 'todo')]).toHaveLength(1);

    s = kanbanReducer(s, { type: 'boardStart', key: 'b' });
    s = kanbanReducer(s, { type: 'boardSuccess', key: 'b', board: board([lane('2')], { laneTotal: 60 }) });
    expect(s.extraCards).toEqual({});
    expect(s.extraLanes).toEqual([]);
    expect(s.nextLaneOffset).toBe(25);
  });

  it('appends continuation cards and dedupes them by id', () => {
    let s = started('a');
    s = kanbanReducer(s, { type: 'boardSuccess', key: 'a', board: board([lane('1')]) });
    const cell = cellId('1', 'todo');
    s = kanbanReducer(s, { type: 'cellSuccess', key: 'a', cell, items: [item(1), item(2)] });
    s = kanbanReducer(s, { type: 'cellSuccess', key: 'a', cell, items: [item(2), item(3)] });
    expect(s.extraCards[cell].map(i => i.id)).toEqual([1, 2, 3]);
  });

  it('records a per-cell error without touching the board', () => {
    let s = started('a');
    s = kanbanReducer(s, { type: 'boardSuccess', key: 'a', board: board([lane('1')]) });
    s = kanbanReducer(s, { type: 'cellError', key: 'a', cell: cellId('1', 'done'), message: 'boom' });
    expect(s.cells[cellId('1', 'done')]).toEqual({ loading: false, error: 'boom' });
    expect(s.board).not.toBeNull();
  });

  it('advances the lane offset after a lane window is appended', () => {
    let s = started('a');
    s = kanbanReducer(s, { type: 'boardSuccess', key: 'a', board: board([lane('1')], { laneTotal: 60 }) });
    s = kanbanReducer(s, { type: 'lanesStart', key: 'a' });
    s = kanbanReducer(s, {
      type: 'lanesSuccess',
      key: 'a',
      response: board([lane('26')], { laneOffset: 25, laneLimit: 25, laneTotal: 60 })
    });
    expect(s.extraLanes.map(l => l.key)).toEqual(['26']);
    expect(s.nextLaneOffset).toBe(50);
  });

  it('drops out-of-order responses across multiple quick filter changes', () => {
    // Sequence: user types quickly A -> B -> C
    let s = started('req-A');
    s = kanbanReducer(s, { type: 'boardStart', key: 'req-B' });
    s = kanbanReducer(s, { type: 'boardStart', key: 'req-C' });

    // Stale response A arrives
    const boardA = board([lane('lane-A')]);
    s = kanbanReducer(s, { type: 'boardSuccess', key: 'req-A', board: boardA });
    expect(s.board).toBeNull(); // Dropped!

    // Stale response B arrives
    const boardB = board([lane('lane-B')]);
    s = kanbanReducer(s, { type: 'boardSuccess', key: 'req-B', board: boardB });
    expect(s.board).toBeNull(); // Dropped!

    // Response C arrives
    const boardC = board([lane('lane-C')]);
    s = kanbanReducer(s, { type: 'boardSuccess', key: 'req-C', board: boardC });
    expect(s.board).toBe(boardC); // Accepted!
    expect(s.board?.lanes[0].key).toBe('lane-C');
    expect(s.loading).toBe(false);
  });

  it('handles cell load errors gracefully and allows retry to succeed', () => {
    let s = started('main');
    s = kanbanReducer(s, { type: 'boardSuccess', key: 'main', board: board([lane('1')]) });

    const cell = cellId('1', 'todo');
    // Start load
    s = kanbanReducer(s, { type: 'cellStart', key: 'main', cell });
    expect(s.cells[cell]).toEqual({ loading: true, error: null });

    // Cell error
    s = kanbanReducer(s, { type: 'cellError', key: 'main', cell, message: 'Network timeout' });
    expect(s.cells[cell]).toEqual({ loading: false, error: 'Network timeout' });

    // User retries
    s = kanbanReducer(s, { type: 'cellStart', key: 'main', cell });
    expect(s.cells[cell]).toEqual({ loading: true, error: null });

    // Success
    s = kanbanReducer(s, { type: 'cellSuccess', key: 'main', cell, items: [item(10), item(11)] });
    expect(s.cells[cell]).toEqual({ loading: false, error: null });
    expect(s.extraCards[cell]).toHaveLength(2);
  });
});
