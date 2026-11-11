export type WorkItemType =
  | 'Epic'
  | 'Feature'
  | 'User Story'
  | 'Product Backlog Item'
  | 'Task'
  | 'Bug';

export type WorkItemState =
  | 'New'
  | 'To Do'
  | 'Active'
  | 'In Progress'
  | 'Resolved'
  | 'Done'
  | 'Closed'
  | 'Removed';

export interface RelationItem {
  id: number;
  relType: 'predecessor' | 'successor' | 'related' | 'parent' | 'child' | 'other';
  relName: string;
  comment?: string;
  url: string;
  title?: string;
  type?: string;
  state?: string;
  assignedTo?: string;
  isUnassigned?: boolean;
  project?: string;
}

export interface WorkItemRelations {
  predecessors: RelationItem[];
  successors: RelationItem[];
  related: RelationItem[];
  total: number;
}

export interface WorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  project: string;
  assignedTo: string;
  assignedAvatar?: string;
  isUnassigned: boolean;
  isBug: boolean;
  isTask: boolean;
  parentId?: number | null;
  parentTitle?: string;
  parentType?: string;
  changedDate: string;
  createdDate?: string;
  priority: number;
  iteration?: string;
  areaPath?: string;
  description?: string;
  url: string;
  storyPoints?: number;
  relations: WorkItemRelations;
  children: WorkItem[];
  // Helper flags
  isBlocked?: boolean;
  isBlocking?: boolean;
}

export interface ProjectStats {
  total: number;
  unassigned: number;
  unassigned_bugs: number;
  unassigned_tasks: number;
  assigned: number;
}

export interface PoolSummary {
  total_items: number;
  total_active_in_org?: number;
  loaded_items?: number;
  unassigned_total: number;
  unassigned_tasks: number;
  unassigned_bugs: number;
  assigned_total: number;
  pbi_count: number;
}

export interface PaginatedWorkItemsResponse {
  items: WorkItem[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  nextCursor?: number | null;
  dataScope: string;
  lastSyncedAt?: string;
  isComplete: boolean;
}

export interface GlobalCounts {
  total_org_active: number;
  total_cached: number;
  total_active_cached: number;
  my_tasks_active: number;
  my_tasks_completed: number;
  my_tasks_total: number;
  unassigned_total: number;
  blocked_total: number;
  bugs_total: number;
  stats_by_project: Record<string, ProjectStats>;
  last_synced_at?: string;
  sync_status: string;
}

export interface SyncStatusResponse {
  status: string;
  lastSyncedAt?: string;
  totalOrgActive: number;
  totalCached: number;
  error?: string | null;
}

export interface WorkItemsPoolResponse {
  summary: PoolSummary;
  stats_by_project: Record<string, ProjectStats>;
  /** Active work only (what Story & Tasks displays). */
  hierarchy: WorkItem[];
  /** Complete hierarchy incl. completed descendants and context ancestors; feeds canonical progress only. */
  progressHierarchy?: WorkItem[];
  /**
   * Active scope PLUS completed items and dependency/hierarchy context rows, as work items. Only the Dependency
   * Explorer graph uses it, so relation targets resolve to their real title/state instead of a placeholder.
   * Lists, counters and the matrix keep using `flat_items` (active scope).
   */
  graphItems?: WorkItem[];
  flat_items: WorkItem[];
  projects: string[];
}

export interface MyWorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  project: string;
  assignedTo: string;
  changedDate: string;
  url: string;
}

export interface MyWorkItemsResponse {
  work_items: MyWorkItem[];
  count: number;
}

export type ViewMode = 'dashboard' | 'explorer' | 'board' | 'hierarchy' | 'dependencies' | 'pull-requests' | 'pipelines' | 'deployments' | 'team-activity' | 'my-history';

export interface FilterOptions {
  searchQuery: string;
  selectedProject: string; // 'all' or project name
  quickFilter: 'all' | 'my-tasks' | 'unassigned' | 'blocked' | 'bugs';
  selectedTypes: string[];
  selectedStates: string[];
  selectedPriorities: number[];
  selectedAssignees?: string[];
  sortBy: 'changedDate' | 'priority' | 'id' | 'title';
  sortOrder: 'asc' | 'desc';
  density: 'comfortable' | 'compact';
}
