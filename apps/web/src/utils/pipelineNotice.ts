export interface PipelineCacheStatus {
  outcome: string;
  complete: boolean;
  stale: boolean;
  lastSyncedAt?: string | null;
  /** True when the accessible-project inventory and every required query finished all their pages. */
  accessibleScopeComplete?: boolean;
  organizationSnapshotComplete?: boolean;
}

export type PipelineNotice = 'none' | 'accessible' | 'partial' | 'failed' | 'stale';

/**
 * Chooses the notice for pipeline data. Only an incomplete read (failed query, unfinished pagination,
 * unreadable data) or an out-of-date snapshot warns. A finished read of the accessible projects is shown
 * with a neutral note, because an unproven organization-wide snapshot is not a data problem by itself.
 */
export function getPipelineNotice(status?: PipelineCacheStatus | null): PipelineNotice {
  if (!status) return 'none';
  if (status.outcome === 'failed') return 'failed';
  if (status.outcome === 'partial') return status.accessibleScopeComplete === true && !status.stale ? 'accessible' : 'partial';
  if (status.stale) return 'stale';
  return 'none';
}
