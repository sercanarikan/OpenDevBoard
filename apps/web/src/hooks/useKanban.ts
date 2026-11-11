import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import type { WorkItem } from '../types';
import type { KanbanColumnKey, KanbanLane, KanbanParams, KanbanResponse, ListParams } from '../types/paging';
import { createLatestRunner, isAbortError } from '../utils/latestRunner';
import { queryKey } from '../utils/listParams';
import { useDebounced } from './useDebounced';

const SEARCH_DEBOUNCE_MS = 300;
export const KANBAN_LANE_LIMIT = 25;
export const KANBAN_CARD_LIMIT = 15;

const COLUMN_KEYS: KanbanColumnKey[] = ['todo', 'in-progress', 'resolved', 'done'];
const LANES_SLOT = 'lanes';

export interface KanbanCellStatus {
  loading: boolean;
  error: string | null;
}

const IDLE: KanbanCellStatus = { loading: false, error: null };

export interface KanbanState {
  /** Query key of the board that is shown or being requested. Responses for any other key are ignored. */
  requestKey: string;
  /** Server window: first KANBAN_LANE_LIMIT lanes with KANBAN_CARD_LIMIT cards per lane-column. */
  board: KanbanResponse | null;
  extraLanes: KanbanLane[];
  extraCards: Record<string, WorkItem[]>;
  nextLaneOffset: number;
  loading: boolean;
  error: string | null;
  cells: Record<string, KanbanCellStatus>;
  lanes: KanbanCellStatus;
}

export const INITIAL_KANBAN_STATE: KanbanState = {
  requestKey: '',
  board: null,
  extraLanes: [],
  extraCards: {},
  nextLaneOffset: 0,
  loading: true,
  error: null,
  cells: {},
  lanes: IDLE
};

export type KanbanAction =
  | { type: 'boardStart'; key: string }
  | { type: 'boardSuccess'; key: string; board: KanbanResponse }
  | { type: 'boardError'; key: string; message: string }
  | { type: 'cellStart'; key: string; cell: string }
  | { type: 'cellSuccess'; key: string; cell: string; items: WorkItem[] }
  | { type: 'cellError'; key: string; cell: string; message: string }
  | { type: 'lanesStart'; key: string }
  | { type: 'lanesSuccess'; key: string; response: KanbanResponse }
  | { type: 'lanesError'; key: string; message: string };

/** Identity of one lane-column continuation (`lane` + `column` on GET /api/work-items). */
export function cellId(laneKey: string, column: KanbanColumnKey): string {
  return JSON.stringify([laneKey, column]);
}

/** Appends `extra` to `base`, keeping order and dropping ids that are already present. */
export function mergeCards(base: WorkItem[], extra: WorkItem[]): WorkItem[] {
  const seen = new Set<number>();
  const out: WorkItem[] = [];
  for (const item of [...base, ...extra]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Appends lanes whose key is not yet known, keeping server order. */
export function mergeLanes(base: KanbanLane[], extra: KanbanLane[]): KanbanLane[] {
  const seen = new Set<string>();
  const out: KanbanLane[] = [];
  for (const lane of [...base, ...extra]) {
    if (seen.has(lane.key)) continue;
    seen.add(lane.key);
    out.push(lane);
  }
  return out;
}

/** Cards of a lane-column that still exist on the server but were not loaded yet. */
export function remainingCount(total: number, loaded: number): number {
  return Math.max(0, total - loaded);
}

/** Board with the appended lanes and cards merged in. The server window itself is never modified. */
export function composeBoard(
  board: KanbanResponse | null,
  extraLanes: KanbanLane[],
  extraCards: Record<string, WorkItem[]>
): KanbanResponse | null {
  if (!board) return null;
  const lanes = mergeLanes(board.lanes, extraLanes).map(lane => {
    const columns = {} as Record<KanbanColumnKey, WorkItem[]>;
    for (const col of COLUMN_KEYS) {
      columns[col] = mergeCards(lane.columns[col] ?? [], extraCards[cellId(lane.key, col)] ?? []);
    }
    return { ...lane, columns };
  });
  return { ...board, lanes };
}

/** Filter, search and sort fields only: no swimlane, window or board-only options leak into list requests. */
export function toListParams(p: KanbanParams): ListParams {
  return {
    search: p.search,
    project: p.project,
    assignee: p.assignee,
    quickFilter: p.quickFilter,
    currentUser: p.currentUser,
    types: p.types,
    states: p.states,
    priorities: p.priorities,
    includeCompleted: p.includeCompleted,
    sortBy: p.sortBy,
    sortOrder: p.sortOrder
  };
}

export function kanbanReducer(state: KanbanState, action: KanbanAction): KanbanState {
  if (action.type === 'boardStart') {
    return { ...state, requestKey: action.key, loading: true, error: null };
  }
  if (action.key !== state.requestKey) return state;

  switch (action.type) {
    case 'boardSuccess':
      return {
        ...state,
        board: action.board,
        extraLanes: [],
        extraCards: {},
        nextLaneOffset: action.board.laneOffset + action.board.laneLimit,
        loading: false,
        error: null,
        cells: {},
        lanes: IDLE
      };
    case 'boardError':
      return { ...state, loading: false, error: action.message };
    case 'cellStart':
      return { ...state, cells: { ...state.cells, [action.cell]: { loading: true, error: null } } };
    case 'cellSuccess':
      return {
        ...state,
        extraCards: {
          ...state.extraCards,
          [action.cell]: mergeCards(state.extraCards[action.cell] ?? [], action.items)
        },
        cells: { ...state.cells, [action.cell]: IDLE }
      };
    case 'cellError':
      return { ...state, cells: { ...state.cells, [action.cell]: { loading: false, error: action.message } } };
    case 'lanesStart':
      return { ...state, lanes: { loading: true, error: null } };
    case 'lanesSuccess': {
      if (!state.board) return state;
      const boardKeys = new Set(state.board.lanes.map(l => l.key));
      return {
        ...state,
        extraLanes: mergeLanes(state.extraLanes, action.response.lanes).filter(l => !boardKeys.has(l.key)),
        nextLaneOffset: action.response.laneOffset + action.response.laneLimit,
        lanes: IDLE
      };
    }
    case 'lanesError':
      return { ...state, lanes: { loading: false, error: action.message } };
    default:
      return state;
  }
}

const errorMessage = (e: unknown): string => (e as Error)?.message || 'error';

/**
 * Kanban board data: a server window of lanes and cards (GET /api/kanban), plus on-demand continuation per
 * lane-column (GET /api/work-items with `lane` + `column`) and per lane window (GET /api/kanban with laneOffset).
 *  - search is debounced; a newer query aborts the previous one and late responses are ignored
 *  - the previous board stays visible while a reload runs (no flicker)
 *  - any reload (filter, sort, swimlane, hide-completed, data version) replaces the board and drops the appended
 *    cards and lanes in the same update, so offsets always match the data they were loaded with
 */
export function useKanban(params: KanbanParams) {
  const { api, refreshToken, booting } = useApp();
  const enabled = !booting;

  const debouncedSearch = useDebounced(params.search ?? '', SEARCH_DEBOUNCE_MS);
  const effective = useMemo<KanbanParams>(
    () => ({ ...params, search: debouncedSearch, includeCompleted: true }),
    [params, debouncedSearch]
  );
  const key = queryKey(effective);

  const [state, dispatch] = useReducer(kanbanReducer, INITIAL_KANBAN_STATE);
  const [retryNonce, setRetryNonce] = useState(0);

  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;
  /** Params of the board request that produced `state.board`: continuation must use exactly these. */
  const boardParamsRef = useRef<KanbanParams>(effective);
  const stateRef = useRef(state);
  stateRef.current = state;

  const runnerRef = useRef(createLatestRunner());
  /** Bumped on every reload: continuation responses from an older epoch are dropped. */
  const epochRef = useRef(0);
  const inflightRef = useRef(new Map<string, AbortController>());

  const abortInflight = useCallback(() => {
    epochRef.current++;
    for (const controller of inflightRef.current.values()) controller.abort();
    inflightRef.current.clear();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    abortInflight();
    const requested = effectiveRef.current;
    runnerRef.current.run(
      signal =>
        api.kanban({ ...requested, laneOffset: 0, laneLimit: KANBAN_LANE_LIMIT, cardLimit: KANBAN_CARD_LIMIT }, signal),
      {
        onStart: () => dispatch({ type: 'boardStart', key }),
        onSuccess: board => {
          boardParamsRef.current = requested;
          dispatch({ type: 'boardSuccess', key, board });
        },
        onError: err => dispatch({ type: 'boardError', key, message: errorMessage(err) })
      }
    );
  }, [enabled, api, key, refreshToken, retryNonce, abortInflight]);

  useEffect(() => {
    const runner = runnerRef.current;
    const inflight = inflightRef.current;
    return () => {
      runner.cancel();
      epochRef.current++;
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    };
  }, []);

  const loadMoreCards = useCallback((laneKey: string, column: KanbanColumnKey) => {
    const cell = cellId(laneKey, column);
    const inflight = inflightRef.current;
    if (inflight.has(cell)) return;

    const current = stateRef.current;
    if (current.loading) return;
    const lane = composeBoard(current.board, current.extraLanes, current.extraCards)?.lanes.find(
      l => l.key === laneKey
    );
    if (!lane) return;

    const tag = current.requestKey;
    const epoch = epochRef.current;
    const controller = new AbortController();
    inflight.set(cell, controller);
    dispatch({ type: 'cellStart', key: tag, cell });

    api
      .list(
        {
          ...toListParams(boardParamsRef.current),
          column,
          lane: lane.mode === 'none' ? undefined : `${lane.mode}:${lane.key}`,
          limit: KANBAN_CARD_LIMIT,
          offset: lane.columns[column].length
        },
        controller.signal
      )
      .then(res => {
        if (epochRef.current !== epoch) return;
        dispatch({ type: 'cellSuccess', key: tag, cell, items: res.items });
      })
      .catch(err => {
        if (epochRef.current !== epoch || isAbortError(err)) return;
        dispatch({ type: 'cellError', key: tag, cell, message: errorMessage(err) });
      })
      .finally(() => {
        if (inflight.get(cell) === controller) inflight.delete(cell);
      });
  }, [api]);

  const loadMoreLanes = useCallback(() => {
    const inflight = inflightRef.current;
    const current = stateRef.current;
    if (!current.board || current.loading || inflight.has(LANES_SLOT)) return;
    if (current.nextLaneOffset >= current.board.laneTotal) return;

    const tag = current.requestKey;
    const epoch = epochRef.current;
    const controller = new AbortController();
    inflight.set(LANES_SLOT, controller);
    dispatch({ type: 'lanesStart', key: tag });

    api
      .kanban(
        {
          ...boardParamsRef.current,
          laneOffset: current.nextLaneOffset,
          laneLimit: KANBAN_LANE_LIMIT,
          cardLimit: KANBAN_CARD_LIMIT
        },
        controller.signal
      )
      .then(res => {
        if (epochRef.current !== epoch) return;
        dispatch({ type: 'lanesSuccess', key: tag, response: res });
      })
      .catch(err => {
        if (epochRef.current !== epoch || isAbortError(err)) return;
        dispatch({ type: 'lanesError', key: tag, message: errorMessage(err) });
      })
      .finally(() => {
        if (inflight.get(LANES_SLOT) === controller) inflight.delete(LANES_SLOT);
      });
  }, [api]);

  const retry = useCallback(() => setRetryNonce(n => n + 1), []);

  const board = useMemo(
    () => composeBoard(state.board, state.extraLanes, state.extraCards),
    [state.board, state.extraLanes, state.extraCards]
  );

  const cellStatus = useCallback(
    (laneKey: string, column: KanbanColumnKey): KanbanCellStatus => state.cells[cellId(laneKey, column)] ?? IDLE,
    [state.cells]
  );

  return {
    board,
    loading: state.loading,
    /** A previous board is still shown while a reload or a search debounce is in progress. */
    updating: !!state.board && (state.loading || (params.search ?? '') !== debouncedSearch),
    error: state.error,
    retry,
    loadMoreCards,
    loadMoreLanes,
    cellStatus,
    lanesStatus: state.lanes,
    canLoadMoreLanes: !!state.board && state.nextLaneOffset < state.board.laneTotal
  };
}
