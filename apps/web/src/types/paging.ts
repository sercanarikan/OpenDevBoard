import type { WorkItem } from './index';

export type QuickFilter = 'all' | 'my-tasks' | 'unassigned' | 'blocked' | 'blocking' | 'bugs';
export type SortBy = 'changedDate' | 'priority' | 'id' | 'title' | 'state';
export type SortOrder = 'asc' | 'desc';
export type KanbanColumnKey = 'todo' | 'in-progress' | 'resolved' | 'done';
export type SwimlaneMode = 'none' | 'parent' | 'assignee' | 'priority';

/** Query for GET /api/work-items (contract: docs/pagination-api.md). */
export interface ListParams {
  limit?: number;
  offset?: number;
  search?: string;
  project?: string;
  assignee?: string[];
  quickFilter?: QuickFilter;
  currentUser?: string;
  types?: string[];
  states?: string[];
  priorities?: number[];
  column?: KanbanColumnKey;
  /** `parent:123`, `parent:none`, `assignee:Ada`, `assignee:Unassigned`, `priority:2` */
  lane?: string;
  includeCompleted?: boolean;
  sortBy?: SortBy;
  sortOrder?: SortOrder;
}

export interface ListResponse {
  items: WorkItem[];
  total: number;
  limit: number;
  offset: number;
  hasNext: boolean;
  hasPrev: boolean;
  dataVersion: string;
}

export interface SummaryScope {
  project: string;
  total: number;
  myTasks: number;
  unassigned: number;
  blocked: number;
  myBlocked?: number;
  blocking: number;
  bugs: number;
}

export interface SummaryResponse {
  scope: SummaryScope;
  facets: {
    types: Record<string, number>;
    states: Record<string, number>;
    priorities: Record<string, number>;
  };
  projects: { name: string; total: number }[];
  completed: number;
  dataVersion: string;
}

export interface CanonicalProgress {
  totalUnits: number;
  completedUnits: number;
  percent: number;
  blockedCount?: number;
  unassignedCount?: number;
  hasChildren?: boolean;
}

export interface KanbanParams extends Omit<ListParams, 'limit' | 'offset' | 'column' | 'lane'> {
  swimlane?: SwimlaneMode;
  laneLimit?: number;
  laneOffset?: number;
  cardLimit?: number;
  hideCompleted?: boolean;
}

export interface KanbanLane {
  id: string;
  key: string;
  mode: SwimlaneMode;
  title: string;
  type?: string;
  project?: string;
  total: number;
  counts: Record<KanbanColumnKey, number>;
  columns: Record<KanbanColumnKey, WorkItem[]>;
  progress?: { totalUnits: number; completedUnits: number; percent: number };
}

export interface KanbanResponse {
  columns: Record<KanbanColumnKey, number>;
  total: number;
  laneMode: SwimlaneMode;
  laneTotal: number;
  laneLimit: number;
  laneOffset: number;
  lanes: KanbanLane[];
  dataVersion: string;
}

export interface ChildrenResponse {
  items: WorkItem[];
  total: number;
  truncated?: boolean;
  dataVersion: string;
}

export interface BatchResponse {
  items: WorkItem[];
  missing: number[];
  dataVersion: string;
}

export interface MeResponse {
  displayName: string;
  source: 'live' | 'fixture' | 'demo';
}

export interface SyncReportResponse {
  status: string;
  source?: 'live' | 'fixture';
  lastSyncedAt?: string | null;
  lastSuccessAt?: string | null;
  lastFullSyncAt?: string | null;
  lastIncrementalSyncAt?: string | null;
  lastError?: string | null;
  lastResult?: Record<string, unknown> | null;
  totalOrgActive: number;
  totalCached: number;
  totalActiveCached?: number;
  deletedCount?: number;
  contextCount?: number;
  dataVersion?: string;
  error?: string | null;
}

export class ApiError extends Error {
  status: number;
  isNetwork: boolean;
  isAbort: boolean;

  constructor(message: string, status = 0, opts: { isNetwork?: boolean; isAbort?: boolean } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.isNetwork = !!opts.isNetwork;
    this.isAbort = !!opts.isAbort;
  }
}

/** Data access used by every screen. A live implementation talks to /api, a demo one is in-memory. */
export interface WorkItemsApi {
  mode: 'live' | 'demo';
  me(signal?: AbortSignal): Promise<MeResponse>;
  summary(project: string, currentUser: string, signal?: AbortSignal): Promise<SummaryResponse>;
  list(params: ListParams, signal?: AbortSignal): Promise<ListResponse>;
  kanban(params: KanbanParams, signal?: AbortSignal): Promise<KanbanResponse>;
  progress(ids: number[], signal?: AbortSignal): Promise<Record<number, CanonicalProgress>>;
  children(id: number, signal?: AbortSignal): Promise<ChildrenResponse>;
  batch(ids: number[], signal?: AbortSignal): Promise<BatchResponse>;
  item(id: number, signal?: AbortSignal): Promise<WorkItem | null>;
  pullRequests(params: PullRequestParams, signal?: AbortSignal): Promise<PullRequestsResponse>;
  pullRequestsSummary(project?: string, signal?: AbortSignal): Promise<PullRequestsSummary>;
  pullRequest(id: number, signal?: AbortSignal): Promise<PullRequest | null>;
  pipelines(params: PipelineParams, signal?: AbortSignal): Promise<PipelineRunsResponse>;
  pipelinesSummary(days?: number, project?: string, signal?: AbortSignal): Promise<PipelineSummary>;
  pipelineRun(id: number, project?: string, signal?: AbortSignal): Promise<PipelineRun | null>;
  deployments(params: DeploymentParams, signal?: AbortSignal): Promise<DeploymentsResponse>;
  deploymentsSummary(days?: number, project?: string, signal?: AbortSignal): Promise<DeploymentSummary>;
  deployment(id: number, project?: string, signal?: AbortSignal): Promise<DeploymentRecord | null>;
  teamActivitySummary(days?: number, project?: string, signal?: AbortSignal): Promise<TeamActivitySummary>;
  teamContributors(params: TeamActivityParams, signal?: AbortSignal): Promise<TeamContributorsResponse>;
  teamCommits(params: TeamActivityParams, signal?: AbortSignal): Promise<TeamCommitsResponse>;
  myHistorySummary(days?: number, project?: string, signal?: AbortSignal, filters?: Pick<HistoryParams, 'activityType' | 'search'>): Promise<HistorySummary>;
  myHistoryTimeline(params: HistoryParams, signal?: AbortSignal): Promise<HistoryTimelineResponse>;
}

export type PRQuickFilter = 'all' | 'needs-my-review' | 'created-by-me' | 'involved';
export type PRStatus = 'active' | 'completed' | 'abandoned' | 'all';
export type PRSortBy = 'creationDate' | 'id' | 'title';

export interface PullRequestReviewer {
  id: string;
  displayName: string;
  uniqueName?: string;
  vote: number;
  voteKey: 'approved' | 'approvedWithSuggestions' | 'noVote' | 'waitingForAuthor' | 'rejected';
  voteLabel: string;
  voteLabelEn: string;
  isRequired?: boolean;
  hasDeclined?: boolean;
  avatar?: string;
}

export interface PullRequestLinkedWorkItem {
  id: number;
  url?: string;
}

export interface PullRequest {
  id: number;
  project: string;
  repository: string;
  title: string;
  description: string;
  status: 'active' | 'completed' | 'abandoned';
  isDraft: number | boolean;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  sourceBranch: string;
  targetBranch: string;
  mergeStatus: string;
  creationDate: string;
  closedDate?: string;
  url: string;
  reviewers: PullRequestReviewer[];
  workItems: PullRequestLinkedWorkItem[];
  reviewersCount: number;
  // Personal flags
  isAuthor?: boolean;
  isReviewer?: boolean;
  myVote?: number;
  myVoteKey?: string;
  myVoteLabel?: string;
  myVoteLabelEn?: string;
  needsMyReview?: boolean;
  hasReviewed?: boolean;
}

export interface PullRequestsSummary {
  needsMyReview: number;
  createdByMe: number;
  involved: number;
  totalActive: number;
  lastSyncedAt?: string;
  reviewerIdentityStatus?: { groupMembership: 'available' | 'unavailable' | 'not_requested'; error?: { kind: string; status?: number } };
  cacheStatus?: { outcome: string; complete: boolean; stale: boolean; lastSyncedAt?: string | null; hasSnapshot?: boolean; errors?: { kind: string; status?: number }[] };
}

export interface PullRequestsResponse {
  items: PullRequest[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  summary: PullRequestsSummary;
  dataScope: string;
  lastSyncedAt?: string;
  reviewerIdentityStatus?: PullRequestsSummary['reviewerIdentityStatus'];
  cacheStatus?: PullRequestsSummary['cacheStatus'];
}

export interface PullRequestParams {
  project?: string;
  repository?: string;
  status?: PRStatus;
  quickFilter?: PRQuickFilter;
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: PRSortBy;
  sortOrder?: SortOrder;
  refresh?: boolean;
}

// ---- Pipelines ----

export interface PipelineRun {
  id: number;
  project: string;
  pipelineId?: number;
  pipelineName: string;
  pipelineType: 'yaml' | 'classic';
  buildNumber: string;
  status: 'inProgress' | 'completed' | 'notStarted' | string;
  result?: 'succeeded' | 'failed' | 'partiallySucceeded' | 'canceled' | string | null;
  sourceBranch: string;
  sourceVersion?: string;
  requestedBy: string;
  queueTime: string;
  startTime?: string;
  finishTime?: string;
  durationSeconds: number;
  url: string;
}

export interface PipelineDailyStat {
  date: string;
  succeeded: number;
  failed: number;
  total: number;
}

export interface PipelineSummary {
  periodDays: number;
  totalPipelines: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  partiallySucceeded: number;
  inProgress: number;
  canceled: number;
  successRate: number;
  failedRuns: PipelineRun[];
  dailyStats: PipelineDailyStat[];
  lastSyncedAt?: string;
  cacheStatus?: { outcome: string; complete: boolean; stale: boolean; lastSyncedAt?: string | null };
}

export interface PipelineRunsResponse {
  items: PipelineRun[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  summary: PipelineSummary;
  cacheStatus?: PipelineSummary['cacheStatus'];
  dataScope: string;
  lastSyncedAt?: string;
}

export interface PipelineParams {
  project?: string;
  status?: string;
  result?: string;
  branch?: string;
  search?: string;
  days?: number;
  limit?: number;
  offset?: number;
  refresh?: boolean;
}

// ---- Deployments ----

export interface DeploymentRecord {
  id: number;
  project: string;
  releaseId?: number;
  releaseName: string;
  definitionId?: number;
  definitionName: string;
  environmentId?: number;
  environmentName: string;
  status: 'succeeded' | 'failed' | 'inProgress' | 'notDeployed' | 'canceled' | string;
  attempt: number;
  startedOn: string;
  completedOn?: string;
  durationSeconds: number;
  requestedBy: string;
  url: string;
}

export interface DeploymentEnvironmentStat {
  name: string;
  total: number;
  succeeded: number;
  failed: number;
  inProgress: number;
  successRate: number;
}

export interface DeploymentProjectStat {
  project: string;
  total: number;
  succeeded: number;
  failed: number;
  inProgress: number;
  successRate: number;
}

export interface DeploymentSummary {
  periodDays: number;
  totalDeployments: number;
  succeeded: number;
  failed: number;
  inProgress: number;
  successRate: number;
  environments: DeploymentEnvironmentStat[];
  projects?: DeploymentProjectStat[];
  dailyStats: PipelineDailyStat[];
  lastSyncedAt?: string;
  cacheStatus?: { outcome: string; complete: boolean; stale: boolean; lastSyncedAt?: string | null; hasSnapshot?: boolean; errors?: { kind: string; status?: number }[] };
}

export interface DeploymentsResponse {
  items: DeploymentRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  summary: DeploymentSummary;
  cacheStatus?: DeploymentSummary['cacheStatus'];
  supportedSources?: string[];
  dataScope: string;
  lastSyncedAt?: string;
}

export interface DeploymentParams {
  project?: string;
  environment?: string;
  status?: string;
  search?: string;
  days?: number;
  limit?: number;
  offset?: number;
  refresh?: boolean;
}

// ---- Team Activity ----

export interface TeamContributor {
  name: string;
  email: string;
  commitCount: number;
  authoredPRs: number;
  reviewsCount: number;
  lastActivity: string;
}

export interface TeamCommit {
  commitId: string;
  project: string;
  repository: string;
  author: string;
  authorEmail?: string;
  date: string;
  comment: string;
  url?: string;
}

export interface TeamRepositoryStat {
  project: string;
  repository: string;
  commitCount: number;
  prCount: number;
  lastActivity: string;
}

export interface TeamDailyStat {
  date: string;
  commits: number;
  prs: number;
  total: number;
}

export interface TeamActivitySummary {
  periodDays: number;
  totalCommits: number;
  totalPRs: number;
  activeContributors: number;
  dailyStats: TeamDailyStat[];
  contributors: TeamContributor[];
  repositories: TeamRepositoryStat[];
  lastSyncedAt?: string;
}

export interface TeamContributorsResponse {
  items: TeamContributor[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  lastSyncedAt?: string;
}

export interface TeamCommitsResponse {
  items: TeamCommit[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  lastSyncedAt?: string;
}

export interface TeamActivityParams {
  project?: string;
  repository?: string;
  contributor?: string;
  search?: string;
  days?: number;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: SortOrder;
  refresh?: boolean;
}

// ---- My History ----

export interface HistoryEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  project: string;
  entity: {
    type: string;
    id: string | number;
    title: string;
    repository?: string;
  };
  summary: string;
  url?: string;
  actor: {
    id?: string;
    displayName: string;
  };
}

export interface HistoryDailyStat {
  date: string;
  count: number;
  commits: number;
  workItems: number;
  prs: number;
}

export interface HistorySummary {
  periodDays: number;
  totalEvents: number;
  totalMatchingEvents?: number;
  completedWorkItems: number;
  commitsCount: number;
  prsCount: number;
  reviewsCount: number;
  projectsTouched: string[];
  dailyHeatmap: HistoryDailyStat[];
  lastSyncedAt?: string;
}

export interface HistoryTimelineResponse {
  items: HistoryEvent[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  lastSyncedAt?: string;
}

export interface HistoryParams {
  project?: string;
  activityType?: string;
  search?: string;
  days?: number;
  limit?: number;
  offset?: number;
  refresh?: boolean;
}
