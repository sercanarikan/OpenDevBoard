import type { WorkItem } from '../types';
import { mockFlatItems, CURRENT_USER_NAME } from './mockData';
import { buildHierarchyTree } from '../utils/hierarchy';
import { computeCanonicalProgressMap } from '../utils/progress';
import { getKanbanColumnForState } from '../utils/kanbanEngine';
import { isWorkItemCompleted } from '../utils/workState';
import {
  type BatchResponse,
  type CanonicalProgress,
  type ChildrenResponse,
  type KanbanColumnKey,
  type KanbanLane,
  type KanbanParams,
  type KanbanResponse,
  type ListParams,
  type ListResponse,
  type MeResponse,
  type SummaryResponse,
  type WorkItemsApi,
  type PullRequest,
  type PullRequestParams,
  type PullRequestsResponse,
  type PullRequestsSummary,
  type PipelineRun,
  type PipelineParams,
  type PipelineRunsResponse,
  type PipelineSummary,
  type DeploymentRecord,
  type DeploymentParams,
  type DeploymentsResponse,
  type DeploymentSummary,
  type TeamActivityParams,
  type TeamActivitySummary,
  type TeamContributorsResponse,
  type TeamCommitsResponse,
  type TeamContributor,
  type TeamCommit,
  type HistorySummary,
  type HistoryTimelineResponse,
  type HistoryParams,
  type HistoryEvent
} from '../types/paging';

/**
 * In-memory implementation of the same contract the backend serves (docs/pagination-api.md), over the bundled
 * sample dataset. It is only ever selected when the backend is unreachable at start-up and is always labelled
 * "Demo Mode"; it never touches, caches or merges live data.
 */
const VERSION = 'demo';

function withFlags(items: WorkItem[]): WorkItem[] {
  return items.map(i => ({
    ...i,
    isBlocked: i.relations.predecessors.some(p => !isWorkItemCompleted(p.state || '', p.type || '')),
    isBlocking: i.relations.successors.length > 0
  }));
}

const ALL: WorkItem[] = withFlags(mockFlatItems);
const BY_ID = new Map(ALL.map(i => [i.id, i]));
const isActive = (i: WorkItem) => !isWorkItemCompleted(i.state, i.type) && i.state.toLowerCase() !== 'removed';

const fold = (s: string) => (s || '').toLocaleLowerCase('tr').normalize('NFKC');

function matches(i: WorkItem, p: ListParams): boolean {
  if (!p.includeCompleted && !isActive(i)) return false;
  if (p.project && p.project !== 'all' && i.project !== p.project) return false;
  if (p.assignee?.length) {
    const ok = p.assignee.some(a => (a === 'Unassigned' ? i.isUnassigned : i.assignedTo === a));
    if (!ok) return false;
  }
  switch (p.quickFilter) {
    case 'my-tasks':
      if (!p.currentUser || i.assignedTo !== p.currentUser) return false;
      break;
    case 'unassigned':
      if (!i.isUnassigned) return false;
      break;
    case 'blocked':
      if (!i.isBlocked) return false;
      break;
    case 'blocking':
      if (!i.isBlocking) return false;
      break;
    case 'bugs':
      if (!i.isBug) return false;
      break;
  }
  if (p.types?.length && !p.types.includes(i.type)) return false;
  if (p.states?.length && !p.states.includes(i.state)) return false;
  if (p.priorities?.length && !p.priorities.includes(i.priority)) return false;
  if (p.column && getKanbanColumnForState(i.state) !== p.column) return false;
  if (p.lane) {
    const [mode, key] = [p.lane.slice(0, p.lane.indexOf(':')), p.lane.slice(p.lane.indexOf(':') + 1)];
    if (mode === 'parent' && String(i.parentId ?? 'none') !== key) return false;
    if (mode === 'assignee' && (key === 'Unassigned' ? !i.isUnassigned : i.assignedTo !== key)) return false;
    if (mode === 'priority' && String(i.priority) !== key) return false;
  }
  if (p.search && p.search.trim()) {
    const words = fold(p.search).split(/\s+/).filter(Boolean);
    const hay = [i.title, String(i.id), i.assignedTo, i.project, i.parentTitle || ''].map(fold);
    if (!words.every(w => hay.some(h => h.includes(w)))) return false;
  }
  return true;
}

function sorter(sortBy: string = 'changedDate', sortOrder: string = 'desc') {
  const dir = sortOrder === 'asc' ? 1 : -1;
  return (a: WorkItem, b: WorkItem): number => {
    let c = 0;
    if (sortBy === 'priority') {
      c = a.priority - b.priority;
      if (c === 0) c = (b.isBlocked ? 1 : 0) - (a.isBlocked ? 1 : 0);
      if (c === 0) c = (b.changedDate || '').localeCompare(a.changedDate || '');
      return c === 0 ? a.id - b.id : c * dir;
    }
    if (sortBy === 'id') c = a.id - b.id;
    else if (sortBy === 'title') c = a.title.localeCompare(b.title);
    else if (sortBy === 'state') c = a.state.localeCompare(b.state);
    else c = (a.changedDate || '').localeCompare(b.changedDate || '');
    return c === 0 ? a.id - b.id : c * dir;
  };
}

function filtered(p: ListParams): WorkItem[] {
  return ALL.filter(i => matches(i, p)).sort(sorter(p.sortBy, p.sortOrder));
}

function laneKey(mode: string, i: WorkItem): string {
  if (mode === 'parent') return String(i.parentId ?? 'none');
  if (mode === 'assignee') return i.isUnassigned ? 'Unassigned' : i.assignedTo;
  if (mode === 'priority') return String(i.priority);
  return 'all';
}

function emptyCols<T>(make: () => T): Record<KanbanColumnKey, T> {
  return { todo: make(), 'in-progress': make(), resolved: make(), done: make() };
}

export const demoApi: WorkItemsApi = {
  mode: 'demo',

  async me(): Promise<MeResponse> {
    return { displayName: CURRENT_USER_NAME, source: 'demo' };
  },

  async summary(project, currentUser): Promise<SummaryResponse> {
    const scope = ALL.filter(i => isActive(i) && (project === 'all' || !project || i.project === project));
    const facets = { types: {} as Record<string, number>, states: {} as Record<string, number>, priorities: {} as Record<string, number> };
    for (const i of scope) {
      facets.types[i.type] = (facets.types[i.type] || 0) + 1;
      facets.states[i.state] = (facets.states[i.state] || 0) + 1;
      facets.priorities[String(i.priority)] = (facets.priorities[String(i.priority)] || 0) + 1;
    }
    const perProject = new Map<string, number>();
    for (const i of ALL.filter(isActive)) perProject.set(i.project, (perProject.get(i.project) || 0) + 1);
    return {
      scope: {
        project: project || 'all',
        total: scope.length,
        myTasks: currentUser ? scope.filter(i => i.assignedTo === currentUser).length : 0,
        unassigned: scope.filter(i => i.isUnassigned).length,
        blocked: scope.filter(i => i.isBlocked).length,
        myBlocked: currentUser ? scope.filter(i => i.assignedTo === currentUser && i.isBlocked).length : 0,
        blocking: scope.filter(i => i.isBlocking).length,
        bugs: scope.filter(i => i.isBug).length
      },
      facets,
      projects: [...perProject.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, total]) => ({ name, total })),
      completed: ALL.filter(i => !isActive(i) && (project === 'all' || !project || i.project === project)).length,
      dataVersion: VERSION
    };
  },

  async list(p): Promise<ListResponse> {
    const limit = Math.max(1, Math.min(200, p.limit ?? 50));
    const offset = Math.max(0, p.offset ?? 0);
    const rows = filtered(p);
    const items = rows.slice(offset, offset + limit);
    return {
      items,
      total: rows.length,
      limit,
      offset,
      hasNext: offset + items.length < rows.length,
      hasPrev: offset > 0,
      dataVersion: VERSION
    };
  },

  async kanban(p: KanbanParams): Promise<KanbanResponse> {
    const mode = p.swimlane || 'none';
    const cardLimit = Math.max(1, Math.min(50, p.cardLimit ?? 15));
    const laneLimit = Math.max(1, Math.min(100, p.laneLimit ?? 25));
    const laneOffset = Math.max(0, p.laneOffset ?? 0);
    const rows = filtered({ ...p, includeCompleted: p.includeCompleted && !p.hideCompleted });
    const visible = p.hideCompleted ? rows.filter(i => getKanbanColumnForState(i.state) !== 'done') : rows;

    const columns = emptyCols(() => 0);
    const groups = new Map<string, WorkItem[]>();
    for (const i of visible) {
      columns[getKanbanColumnForState(i.state)]++;
      const k = laneKey(mode, i);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(i);
    }

    const progressMap = computeCanonicalProgressMap(buildHierarchyTree(ALL));
    const keys = [...groups.keys()];
    const order = (k: string) => (k === 'none' || k === 'Unassigned' ? 1 : 0);
    keys.sort((a, b) => {
      if (mode === 'priority') return Number(a) - Number(b);
      return order(a) - order(b) || groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b);
    });

    const lanes: KanbanLane[] = keys.slice(laneOffset, laneOffset + laneLimit).map(k => {
      const items = groups.get(k)!;
      const counts = emptyCols(() => 0);
      const cols = emptyCols<WorkItem[]>(() => []);
      for (const i of items) {
        const c = getKanbanColumnForState(i.state);
        counts[c]++;
        if (cols[c].length < cardLimit) cols[c].push(i);
      }
      const parent = mode === 'parent' && k !== 'none' ? BY_ID.get(Number(k)) : undefined;
      const canonical = parent ? progressMap.get(parent.id) : undefined;
      const done = counts.done;
      return {
        id: mode === 'none' ? 'all' : `${mode}-${k}`,
        key: k,
        mode,
        title:
          mode === 'parent'
            ? k === 'none'
              ? 'Independent'
              : `#${k} ${parent?.title ?? items[0]?.parentTitle ?? ''}`.trim()
            : mode === 'priority'
            ? `P${k}`
            : mode === 'assignee'
            ? k === 'Unassigned'
              ? 'Unassigned Pool'
              : k
            : 'All',
        type: parent?.type,
        project: parent?.project,
        total: items.length,
        counts,
        columns: cols,
        progress: canonical
          ? { totalUnits: canonical.totalUnits, completedUnits: canonical.completedUnits, percent: canonical.percent }
          : {
              totalUnits: items.length,
              completedUnits: done,
              percent: items.length ? Math.floor((done / items.length) * 100 + 0.5) : 0
            }
      };
    });

    return {
      columns,
      total: visible.length,
      laneMode: mode,
      laneTotal: keys.length,
      laneLimit,
      laneOffset,
      lanes,
      dataVersion: VERSION
    };
  },

  async progress(ids): Promise<Record<number, CanonicalProgress>> {
    const map = computeCanonicalProgressMap(buildHierarchyTree(ALL));
    const out: Record<number, CanonicalProgress> = {};
    for (const id of ids) {
      const r = map.get(id);
      if (r) out[id] = r;
    }
    return out;
  },

  async children(id): Promise<ChildrenResponse> {
    const items = ALL.filter(i => i.parentId === id).sort(
      (a, b) => Number(isActive(b)) - Number(isActive(a)) || a.priority - b.priority || a.id - b.id
    );
    return { items, total: items.length, truncated: false, dataVersion: VERSION };
  },

  async batch(ids): Promise<BatchResponse> {
    const unique = Array.from(new Set(ids));
    return {
      items: unique.map(i => BY_ID.get(i)).filter((x): x is WorkItem => !!x),
      missing: unique.filter(i => !BY_ID.has(i)),
      dataVersion: VERSION
    };
  },

  async item(id): Promise<WorkItem | null> {
    return BY_ID.get(id) || null;
  },

  async pullRequests(params: PullRequestParams): Promise<PullRequestsResponse> {
    let items = DEMO_PRS;
    if (params.project && params.project !== 'all') {
      items = items.filter(p => p.project === params.project);
    }
    if (params.quickFilter === 'needs-my-review') {
      items = items.filter(p => p.needsMyReview);
    } else if (params.quickFilter === 'created-by-me') {
      items = items.filter(p => p.isAuthor);
    } else if (params.quickFilter === 'involved') {
      items = items.filter(p => p.isAuthor || p.isReviewer);
    }
    if (params.search) {
      const q = params.search.toLowerCase();
      items = items.filter(p => p.title.toLowerCase().includes(q) || String(p.id).includes(q));
    }
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
      hasMore: offset + limit < items.length,
      summary: {
        needsMyReview: DEMO_PRS.filter(p => p.needsMyReview).length,
        createdByMe: DEMO_PRS.filter(p => p.isAuthor).length,
        involved: DEMO_PRS.filter(p => p.isAuthor || p.isReviewer).length,
        totalActive: DEMO_PRS.filter(p => p.status === 'active').length
      },
      dataScope: 'demo',
      lastSyncedAt: new Date().toISOString()
    };
  },

  async pullRequestsSummary(project): Promise<PullRequestsSummary> {
    let items = DEMO_PRS;
    if (project && project !== 'all') items = items.filter(p => p.project === project);
    return {
      needsMyReview: items.filter(p => p.needsMyReview).length,
      createdByMe: items.filter(p => p.isAuthor).length,
      involved: items.filter(p => p.isAuthor || p.isReviewer).length,
      totalActive: items.filter(p => p.status === 'active').length,
      lastSyncedAt: new Date().toISOString()
    };
  },

  async pullRequest(id): Promise<PullRequest | null> {
    return DEMO_PRS.find(p => p.id === id) || null;
  },

  async pipelines(params: PipelineParams): Promise<PipelineRunsResponse> {
    let items = DEMO_PIPELINES;
    if (params.project && params.project !== 'all') {
      items = items.filter(r => r.project === params.project);
    }
    if (params.status && params.status !== 'all') {
      items = items.filter(r => r.status === params.status);
    }
    if (params.result && params.result !== 'all') {
      items = items.filter(r => r.result === params.result);
    }
    if (params.search) {
      const q = params.search.toLowerCase();
      items = items.filter(r => r.pipelineName.toLowerCase().includes(q) || String(r.id).includes(q));
    }
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    const summary = computeDemoPipelineSummary(items, params.days ?? 30);
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
      hasMore: offset + limit < items.length,
      summary,
      dataScope: 'demo',
      lastSyncedAt: new Date().toISOString()
    };
  },

  async pipelinesSummary(days = 30, project): Promise<PipelineSummary> {
    let items = DEMO_PIPELINES;
    if (project && project !== 'all') items = items.filter(r => r.project === project);
    return computeDemoPipelineSummary(items, days);
  },

  async pipelineRun(id): Promise<PipelineRun | null> {
    return DEMO_PIPELINES.find(r => r.id === id) || null;
  },

  async deployments(params: DeploymentParams): Promise<DeploymentsResponse> {
    let items = DEMO_DEPLOYMENTS;
    if (params.project && params.project !== 'all') {
      items = items.filter(d => d.project === params.project);
    }
    if (params.environment && params.environment !== 'all') {
      items = items.filter(d => d.environmentName.toLowerCase() === params.environment?.toLowerCase());
    }
    if (params.status && params.status !== 'all') {
      items = items.filter(d => d.status.toLowerCase() === params.status?.toLowerCase());
    }
    if (params.search) {
      const q = params.search.toLowerCase();
      items = items.filter(d => d.releaseName.toLowerCase().includes(q) || d.definitionName.toLowerCase().includes(q));
    }
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    const summary = computeDemoDeploymentSummary(items, params.days ?? 30);
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
      hasMore: offset + limit < items.length,
      summary,
      supportedSources: ['Demo Release Deployments'],
      dataScope: 'demo',
      lastSyncedAt: new Date().toISOString()
    };
  },

  async deploymentsSummary(days = 30, project): Promise<DeploymentSummary> {
    let items = DEMO_DEPLOYMENTS;
    if (project && project !== 'all') items = items.filter(d => d.project === project);
    return computeDemoDeploymentSummary(items, days);
  },

  async deployment(id): Promise<DeploymentRecord | null> {
    return DEMO_DEPLOYMENTS.find(d => d.id === id) || null;
  },

  async teamActivitySummary(days = 30, project): Promise<TeamActivitySummary> {
    let commits = DEMO_COMMITS;
    let prs = DEMO_PRS;
    if (project && project !== 'all') {
      commits = commits.filter(c => c.project === project);
      prs = prs.filter(p => p.project === project);
    }
    return computeDemoTeamSummary(commits, prs, days);
  },

  async teamContributors(params: TeamActivityParams): Promise<TeamContributorsResponse> {
    const summary = await this.teamActivitySummary(params.days ?? 30, params.project);
    let items = summary.contributors;
    if (params.search) {
      const q = params.search.toLowerCase();
      items = items.filter(c => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
    }
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
      hasMore: offset + limit < items.length,
      lastSyncedAt: new Date().toISOString()
    };
  },

  async teamCommits(params: TeamActivityParams): Promise<TeamCommitsResponse> {
    let items = DEMO_COMMITS;
    if (params.project && params.project !== 'all') {
      items = items.filter(c => c.project === params.project);
    }
    if (params.repository && params.repository !== 'all') {
      items = items.filter(c => c.repository === params.repository);
    }
    if (params.contributor && params.contributor !== 'all') {
      items = items.filter(c => c.author === params.contributor);
    }
    if (params.search) {
      const q = params.search.toLowerCase();
      items = items.filter(c => c.comment.toLowerCase().includes(q) || c.author.toLowerCase().includes(q));
    }
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
      hasMore: offset + limit < items.length,
      lastSyncedAt: new Date().toISOString()
    };
  },

  async myHistorySummary(days = 30, project = 'all', _signal?: AbortSignal, filters: Pick<HistoryParams, 'activityType' | 'search'> = {}): Promise<HistorySummary> {
    let events = project === 'all' ? DEMO_HISTORY_EVENTS : DEMO_HISTORY_EVENTS.filter(e => e.project.toLowerCase() === project.toLowerCase());
    if (filters.activityType && filters.activityType !== 'all') {
      events = events.filter(e => e.entity.type.toLowerCase() === filters.activityType!.toLowerCase() || e.eventType.toLowerCase().includes(filters.activityType!.toLowerCase()));
    }
    if (filters.search?.trim()) {
      const q = filters.search.trim().toLowerCase();
      events = events.filter(e => `${e.summary} ${e.entity.title} ${e.project} ${e.entity.id}`.toLowerCase().includes(q));
    }
    return computeDemoHistorySummary(events, days);
  },

  async myHistoryTimeline(params: HistoryParams): Promise<HistoryTimelineResponse> {
    let items = DEMO_HISTORY_EVENTS;
    if (params.project && params.project !== 'all') {
      items = items.filter(e => e.project === params.project);
    }
    if (params.activityType && params.activityType !== 'all') {
      const activityType = params.activityType.toLowerCase();
      items = items.filter(e => e.entity.type.toLowerCase() === activityType || e.eventType.toLowerCase().includes(activityType));
    }
    if (params.search) {
      const q = params.search.toLowerCase();
      items = items.filter(e => `${e.summary} ${e.entity.title} ${e.project} ${e.entity.id}`.toLowerCase().includes(q));
    }
    const limit = params.limit ?? 25;
    const offset = params.offset ?? 0;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
      hasMore: offset + limit < items.length,
      lastSyncedAt: new Date().toISOString()
    };
  }
};

function computeDemoHistorySummary(events: HistoryEvent[], days: number): HistorySummary {
  const completedWorkItems = events.filter(e => e.entity.type === 'workItem').length;
  const commitsCount = events.filter(e => e.entity.type === 'commit').length;
  const prsCount = events.filter(e => e.eventType === 'git.pullRequest.merged' || e.eventType === 'git.pullRequest.created').length;
  const reviewsCount = events.filter(e => e.eventType === 'git.pullRequest.reviewed').length;
  const projectsTouched = [...new Set(events.map(e => e.project))];
  return {
    periodDays: days,
    totalEvents: events.length,
    totalMatchingEvents: events.length,
    completedWorkItems,
    commitsCount,
    prsCount,
    reviewsCount,
    projectsTouched,
    dailyHeatmap: [],
    lastSyncedAt: new Date().toISOString()
  };
}

const DEMO_HISTORY_EVENTS: HistoryEvent[] = [
  {
    id: 'evt-d1',
    eventType: 'workItem.closed',
    occurredAt: '2026-11-06T15:00:00Z',
    project: 'sample-catalog',
    entity: {
      type: 'workItem',
      id: 91001,
      title: 'Sample catalog session timeout'
    },
    summary: 'Work Item #91001 tamamlandı ve kapatıldı',
    url: 'https://dev.azure.com/demo/workitem/91001',
    actor: { id: 'usr-1', displayName: CURRENT_USER_NAME }
  },
  {
    id: 'evt-d2',
    eventType: 'git.commit',
    occurredAt: '2026-11-06T14:30:00Z',
    project: 'sample-catalog',
    entity: {
      type: 'commit',
      id: 'a1b2c3d4',
      title: 'feat: Add quality fixes and deployment metrics enhancements',
      repository: 'sample-catalog.web'
    },
    summary: 'sample-catalog.web deposuna commit',
    url: 'https://dev.azure.com/demo/commit/a1b2c3d4',
    actor: { id: 'usr-1', displayName: CURRENT_USER_NAME }
  },
  {
    id: 'evt-d3',
    eventType: 'git.pullRequest.merged',
    occurredAt: '2026-11-05T16:00:00Z',
    project: 'sample-catalog',
    entity: {
      type: 'pullRequest',
      id: 101,
      title: 'feat(auth): Add multi-tenant token validation and token caching',
      repository: 'sample-catalog.web'
    },
    summary: 'Pull Request #101 birleştirildi',
    url: 'https://dev.azure.com/demo/pullrequest/101',
    actor: { id: 'usr-1', displayName: CURRENT_USER_NAME }
  }
];

function computeDemoTeamSummary(commits: TeamCommit[], prs: PullRequest[], days: number): TeamActivitySummary {
  const contribMap = new Map<string, TeamContributor>();
  for (const c of commits) {
    const existing = contribMap.get(c.author) || {
      name: c.author,
      email: c.authorEmail || '',
      commitCount: 0,
      authoredPRs: 0,
      reviewsCount: 0,
      lastActivity: c.date
    };
    existing.commitCount++;
    if (c.date > existing.lastActivity) existing.lastActivity = c.date;
    contribMap.set(c.author, existing);
  }

  for (const p of prs) {
    const existing = contribMap.get(p.authorName) || {
      name: p.authorName,
      email: '',
      commitCount: 0,
      authoredPRs: 0,
      reviewsCount: 0,
      lastActivity: p.creationDate
    };
    existing.authoredPRs++;
    if (p.creationDate > existing.lastActivity) existing.lastActivity = p.creationDate;
    contribMap.set(p.authorName, existing);
  }

  const contributors = [...contribMap.values()].sort((a, b) => (b.commitCount + b.authoredPRs) - (a.commitCount + a.authoredPRs));
  return {
    periodDays: days,
    totalCommits: commits.length,
    totalPRs: prs.length,
    activeContributors: contributors.length,
    dailyStats: [],
    contributors,
    repositories: [],
    lastSyncedAt: new Date().toISOString()
  };
}

const DEMO_COMMITS: TeamCommit[] = [
  {
    commitId: 'a1b2c3d4',
    project: 'sample-catalog',
    repository: 'sample-catalog.web',
    author: CURRENT_USER_NAME,
    authorEmail: 'user@devopsflow.local',
    date: '2026-11-06T14:30:00Z',
    comment: 'feat: Add quality fixes and deployment metrics enhancements',
    url: 'https://dev.azure.com/demo/commit/a1b2c3d4'
  },
  {
    commitId: 'e5f6a7b8',
    project: 'sample-catalog',
    repository: 'sample-catalog.web',
    author: 'Fixture Person A',
    authorEmail: 'ada@devopsflow.local',
    date: '2026-11-06T12:00:00Z',
    comment: 'fix(auth): Token expiration validation',
    url: 'https://dev.azure.com/demo/commit/e5f6a7b8'
  }
];

function computeDemoPipelineSummary(runs: PipelineRun[], days: number): PipelineSummary {
  const succeeded = runs.filter(r => r.result === 'succeeded').length;
  const failed = runs.filter(r => r.result === 'failed').length;
  const partiallySucceeded = runs.filter(r => r.result === 'partiallySucceeded').length;
  const inProgress = runs.filter(r => r.status === 'inProgress').length;
  const canceled = runs.filter(r => r.result === 'canceled').length;
  const completed = succeeded + failed + partiallySucceeded;
  const successRate = completed > 0 ? Math.round((succeeded / completed) * 1000) / 10 : 100.0;
  return {
    periodDays: days,
    totalPipelines: new Set(runs.map(r => r.pipelineName)).size,
    totalRuns: runs.length,
    succeeded,
    failed,
    partiallySucceeded,
    inProgress,
    canceled,
    successRate,
    failedRuns: runs.filter(r => r.result === 'failed'),
    dailyStats: [],
    lastSyncedAt: new Date().toISOString()
  };
}

function computeDemoDeploymentSummary(deps: DeploymentRecord[], days: number): DeploymentSummary {
  const succeeded = deps.filter(d => d.status === 'succeeded').length;
  const failed = deps.filter(d => d.status === 'failed').length;
  const inProgress = deps.filter(d => d.status === 'inProgress').length;
  const completed = succeeded + failed;
  const successRate = completed > 0 ? Math.round((succeeded / completed) * 1000) / 10 : 100.0;
  const envMap = new Map<string, { total: number; succeeded: number; failed: number; inProgress: number }>();
  const projMap = new Map<string, { total: number; succeeded: number; failed: number; inProgress: number }>();
  for (const d of deps) {
    const e = envMap.get(d.environmentName) || { total: 0, succeeded: 0, failed: 0, inProgress: 0 };
    e.total++;
    if (d.status === 'succeeded') e.succeeded++;
    else if (d.status === 'failed') e.failed++;
    else if (d.status === 'inProgress') e.inProgress++;
    envMap.set(d.environmentName, e);

    const p = projMap.get(d.project) || { total: 0, succeeded: 0, failed: 0, inProgress: 0 };
    p.total++;
    if (d.status === 'succeeded') p.succeeded++;
    else if (d.status === 'failed') p.failed++;
    else if (d.status === 'inProgress') p.inProgress++;
    projMap.set(d.project, p);
  }
  const environments = [...envMap.entries()].map(([name, stat]) => ({
    name,
    total: stat.total,
    succeeded: stat.succeeded,
    failed: stat.failed,
    inProgress: stat.inProgress,
    successRate: stat.succeeded + stat.failed > 0 ? Math.round((stat.succeeded / (stat.succeeded + stat.failed)) * 1000) / 10 : 100.0
  }));
  const projects = [...projMap.entries()].map(([name, stat]) => ({
    project: name,
    total: stat.total,
    succeeded: stat.succeeded,
    failed: stat.failed,
    inProgress: stat.inProgress,
    successRate: stat.succeeded + stat.failed > 0 ? Math.round((stat.succeeded / (stat.succeeded + stat.failed)) * 1000) / 10 : 100.0
  }));
  return {
    periodDays: days,
    totalDeployments: deps.length,
    succeeded,
    failed,
    inProgress,
    successRate,
    environments,
    projects,
    dailyStats: [],
    lastSyncedAt: new Date().toISOString()
  };
}

const DEMO_PIPELINES: PipelineRun[] = [
  {
    id: 101,
    project: 'sample-catalog',
    pipelineId: 1,
    pipelineName: 'sample-catalog.CI',
    pipelineType: 'yaml',
    buildNumber: '20261106.1',
    status: 'completed',
    result: 'succeeded',
    sourceBranch: 'main',
    requestedBy: CURRENT_USER_NAME,
    queueTime: '2026-11-06T10:00:00Z',
    startTime: '2026-11-06T10:01:00Z',
    finishTime: '2026-11-06T10:03:00Z',
    durationSeconds: 120,
    url: 'https://dev.azure.com/demo/build/101'
  },
  {
    id: 102,
    project: 'sample-catalog',
    pipelineId: 2,
    pipelineName: 'sample-catalog.Tests',
    pipelineType: 'yaml',
    buildNumber: '20261106.2',
    status: 'completed',
    result: 'failed',
    sourceBranch: 'feature/auth',
    requestedBy: 'Fixture Person A',
    queueTime: '2026-11-06T09:00:00Z',
    startTime: '2026-11-06T09:01:00Z',
    finishTime: '2026-11-06T09:02:15Z',
    durationSeconds: 75,
    url: 'https://dev.azure.com/demo/build/102'
  }
];

const DEMO_DEPLOYMENTS: DeploymentRecord[] = [
  {
    id: 501,
    project: 'sample-catalog',
    releaseId: 10,
    releaseName: 'Release-10',
    definitionId: 1,
    definitionName: 'sample-catalog.Deploy',
    environmentId: 1,
    environmentName: 'Production',
    status: 'succeeded',
    attempt: 1,
    startedOn: '2026-11-06T11:00:00Z',
    completedOn: '2026-11-06T11:05:00Z',
    durationSeconds: 300,
    requestedBy: CURRENT_USER_NAME,
    url: 'https://dev.azure.com/demo/release/501'
  },
  {
    id: 502,
    project: 'sample-catalog',
    releaseId: 10,
    releaseName: 'Release-10',
    definitionId: 1,
    definitionName: 'sample-catalog.Deploy',
    environmentId: 2,
    environmentName: 'Staging',
    status: 'succeeded',
    attempt: 1,
    startedOn: '2026-11-06T10:30:00Z',
    completedOn: '2026-11-06T10:34:00Z',
    durationSeconds: 240,
    requestedBy: CURRENT_USER_NAME,
    url: 'https://dev.azure.com/demo/release/502'
  }
];

const DEMO_PRS: PullRequest[] = [
  {
    id: 101,
    project: 'sample-catalog',
    repository: 'sample-catalog.web',
    title: 'feat(auth): Add multi-tenant token validation and token caching',
    description: 'Implements tenant token isolation and adds cache for validated session JWTs.',
    status: 'active',
    isDraft: 0,
    authorId: 'ada',
    authorName: 'Fixture Person A',
    sourceBranch: 'feature/token-validation',
    targetBranch: 'main',
    mergeStatus: 'succeeded',
    creationDate: '2026-11-05T10:00:00Z',
    url: 'https://dev.azure.com/demo/pr/101',
    reviewers: [
      { id: 'me', displayName: CURRENT_USER_NAME, vote: 0, voteKey: 'noVote', voteLabel: 'İnceleme Bekliyor', voteLabelEn: 'Waiting for review', isRequired: true }
    ],
    workItems: [{ id: 91007 }],
    reviewersCount: 1,
    isAuthor: false,
    isReviewer: true,
    myVote: 0,
    myVoteKey: 'noVote',
    myVoteLabel: 'İnceleme Bekliyor',
    myVoteLabelEn: 'Waiting for review',
    needsMyReview: true,
    hasReviewed: false
  },
  {
    id: 102,
    project: 'sample-catalog',
    repository: 'sample-catalog.service',
    title: 'fix(deps): Resolve circular dependency in event dispatch pipeline',
    description: 'Fixes topological sort when events produce reciprocal notifications.',
    status: 'active',
    isDraft: 0,
    authorId: 'me',
    authorName: CURRENT_USER_NAME,
    sourceBranch: 'feature/kanban-scroll',
    targetBranch: 'main',
    mergeStatus: 'succeeded',
    creationDate: '2026-11-04T12:00:00Z',
    url: 'https://dev.azure.com/demo/pr/102',
    reviewers: [
      { id: 'ada', displayName: 'Fixture Person A', vote: 10, voteKey: 'approved', voteLabel: 'Onaylandı', voteLabelEn: 'Approved', isRequired: true }
    ],
    workItems: [{ id: 17850 }],
    reviewersCount: 1,
    isAuthor: true,
    isReviewer: false,
    myVote: 0,
    needsMyReview: false,
    hasReviewed: false
  }
];

/** Whole sample pool for the screens that need the complete hierarchy (Story & Tasks, Dependency Explorer). */
export function demoPool(): WorkItem[] {
  return ALL;
}
