import type { SortBy, SortOrder } from '../types/paging';

/**
 * The server applies `sortOrder` to the field itself (docs/pagination-api.md): `priority asc` = P1 first,
 * `title asc` = A-Z, `id desc` / `changedDate desc` = newest first.
 *
 * Both screens expose a "natural" default (best-first) and an inverted state:
 *   changedDate -> newest first, priority -> P1 first, id -> newest first, title -> A-Z, state -> A-Z.
 * Which UI value means "natural" differs per screen (Task Explorer: 'desc', Kanban: 'asc'), so callers pass `inverted`.
 */
export function naturalSort(sortBy: SortBy, inverted: boolean): { sortBy: SortBy; sortOrder: SortOrder } {
  const naturalOrder: Record<SortBy, SortOrder> = {
    changedDate: 'desc',
    priority: 'asc',
    id: 'desc',
    title: 'asc',
    state: 'asc'
  };
  const natural = naturalOrder[sortBy];
  const order: SortOrder = inverted ? (natural === 'asc' ? 'desc' : 'asc') : natural;
  return { sortBy, sortOrder: order };
}
