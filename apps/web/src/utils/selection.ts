import type { PipelineRun, PullRequest } from '../types/paging';
import type { WorkItem } from '../types';

/**
 * The record whose details are open. There is exactly one slot, so a work item, a pull request and a pipeline run can
 * never be open side by side, and every selection remembers the page it was made on: leaving that page closes it.
 */
export type Selection =
  | { kind: 'workItem'; page: string; value: WorkItem }
  | { kind: 'pullRequest'; page: string; value: PullRequest }
  | { kind: 'pipelineRun'; page: string; value: PipelineRun };

/** First path segment, so `/tasks` and `/tasks?project=x` are the same page. */
export function pageKeyFromPath(pathname: string): string {
  return '/' + (pathname.split('/').filter(Boolean)[0] ?? '');
}

/** The selection as seen from `page`: a selection made on another page is not visible. */
export function visibleSelection(selection: Selection | null, page: string): Selection | null {
  return selection && selection.page === page ? selection : null;
}

export function select<K extends Selection['kind']>(kind: K, page: string, value: Extract<Selection, { kind: K }>['value'] | null): Selection | null {
  return value === null ? null : ({ kind, page, value } as Selection);
}

/** Closing a record only closes it when it is the one that is open. */
export function closeKind(selection: Selection | null, kind: Selection['kind']): Selection | null {
  return selection && selection.kind === kind ? null : selection;
}

/** Replaces the open work item with a fresher copy of the same record; anything else is left alone. */
export function refreshWorkItem(selection: Selection | null, fresh: WorkItem): Selection | null {
  return selection?.kind === 'workItem' && selection.value.id === fresh.id ? { ...selection, value: fresh } : selection;
}
