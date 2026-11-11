import type { FilterOptions } from '../types';
import type { KanbanParams, ListParams, SwimlaneMode } from '../types/paging';
import { naturalSort } from './serverSort';

/**
 * Sort direction semantics differ per screen (see serverSort.ts):
 *  - Task Explorer: UI 'desc' is the natural (best-first) order, 'asc' inverts it.
 *  - Kanban:        UI 'asc'  is the natural (best-first) order, 'desc' inverts it.
 */
export type SortSemantics = 'explorer' | 'kanban';

export interface ScreenFilters {
  filters: FilterOptions;
  currentUser: string;
}

/** Filters shared by list and kanban requests (everything except paging, sort and lane/column windows). */
export function baseFilterParams({ filters, currentUser }: ScreenFilters): ListParams {
  const params: ListParams = {
    project: filters.selectedProject,
    quickFilter: filters.quickFilter,
    currentUser,
    search: filters.searchQuery,
    types: filters.selectedTypes,
    states: filters.selectedStates,
    priorities: filters.selectedPriorities,
    assignee: filters.selectedAssignees && filters.selectedAssignees.length > 0 ? filters.selectedAssignees : undefined
  };
  return params;
}

export function sortParams(filters: FilterOptions, semantics: SortSemantics) {
  const inverted = semantics === 'explorer' ? filters.sortOrder === 'asc' : filters.sortOrder === 'desc';
  return naturalSort(filters.sortBy, inverted);
}

export function explorerListParams(input: ScreenFilters): ListParams {
  return { ...baseFilterParams(input), ...sortParams(input.filters, 'explorer') };
}

export function kanbanParams(
  input: ScreenFilters,
  opts: { swimlane: SwimlaneMode; hideCompleted: boolean; cardLimit?: number; laneLimit?: number; laneOffset?: number }
): KanbanParams {
  return {
    ...baseFilterParams(input),
    ...sortParams(input.filters, 'kanban'),
    swimlane: opts.swimlane,
    hideCompleted: opts.hideCompleted,
    cardLimit: opts.cardLimit,
    laneLimit: opts.laneLimit,
    laneOffset: opts.laneOffset
  };
}

/** Stable identity of a query (excludes paging) so a change resets pagination and cancels in-flight requests. */
export function queryKey(params: object): string {
  return JSON.stringify(params, (_k, v) => (v === undefined ? null : v));
}
