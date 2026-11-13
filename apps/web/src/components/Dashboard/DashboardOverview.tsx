import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  UserCheck,
  AlertTriangle,
  GitPullRequest,
  GitBranch,
  ArrowRight,
  Clock,
  Kanban,
  Network,
  RotateCcw,
  Sparkles,
  ChevronRight,
  Inbox,
  PlayCircle,
  Server,
  CheckCircle2,
  GitCommit,
  Users,
  History
} from 'lucide-react';
import { useApp } from '../../context/useApp';
import type { WorkItem, ViewMode } from '../../types';
import type { PullRequest, HistoryEvent, TeamActivitySummary } from '../../types/paging';
import { PriorityBadge, TypeBadge } from '../Common/Badge';
import { WorkItemInspector } from '../Explorer/WorkItemInspector';
import { PullRequestInspector } from '../PullRequests/PullRequestInspector';
import { PipelineInspector } from '../Pipelines/PipelineInspector';
import { DeploymentInspector } from '../Deployments/DeploymentInspector';
import { stateLabel } from '../../i18n/labels';
import { getIntegrationState } from '../../utils/integrationStatus';

type LoadState = { request: object; error: string | null; successfulScope?: string };

export const DashboardOverview: React.FC = () => {
  const { t } = useTranslation(['dashboard', 'common', 'deployments']);
  const {
    api,
    source,
    filters,
    setFilters,
    setViewMode,
    summary,
    prSummary,
    prSummaryLoading,
    prSummaryError,
    pipelineSummary,
    pipelineSummaryLoading,
    pipelineSummaryError,
    selectedPipelineRun,
    setSelectedPipelineRun,
    deploymentSummary,
    deploymentSummaryLoading,
    deploymentSummaryError,
    selectedDeployment,
    setSelectedDeployment,
    currentUserName,
    booting,
    refreshToken,
    syncIndicator,
    selectedWorkItem,
    setSelectedWorkItem,
    selectedPR,
    setSelectedPR
  } = useApp();

  const [priorityItems, setPriorityItems] = useState<WorkItem[]>([]);
  const [recentItems, setRecentItems] = useState<WorkItem[]>([]);
  const [pendingPRs, setPendingPRs] = useState<PullRequest[]>([]);

  const [tasksState, setTasksState] = useState<LoadState | null>(null);
  const [prsState, setPrsState] = useState<LoadState | null>(null);
  const [historyState, setHistoryState] = useState<LoadState | null>(null);
  const [teamState, setTeamState] = useState<LoadState | null>(null);

  const [recentEvents, setRecentEvents] = useState<HistoryEvent[]>([]);
  const [teamSnapshot, setTeamSnapshot] = useState<TeamActivitySummary | null>(null);

  const [refreshNonce, setRefreshNonce] = useState(0);

  // Each panel settles independently; keep successful data only within its original scope.
  const request = useMemo(() => ({ api, project: filters.selectedProject, currentUserName, booting, refreshToken, refreshNonce }),
    [api, filters.selectedProject, currentUserName, booting, refreshToken, refreshNonce]);
  const taskScope = JSON.stringify([request.project, request.currentUserName]);
  const tasksAvailable = !!currentUserName && tasksState?.successfulScope === taskScope;
  const prsAvailable = prsState?.successfulScope === request.project;
  const historyAvailable = historyState?.successfulScope === request.project;
  const teamAvailable = teamState?.successfulScope === request.project;
  const loadingTasks = booting ? !tasksAvailable : !!currentUserName && tasksState?.request !== request;
  const loadingPRs = booting ? !prsAvailable : prsState?.request !== request;
  const loadingHistory = booting ? !historyAvailable : historyState?.request !== request;
  const loadingTeam = booting ? !teamAvailable : teamState?.request !== request;
  const errorTasks = !loadingTasks && currentUserName && tasksState?.request === request ? tasksState.error : null;
  const errorPRs = !loadingPRs && prsState?.request === request ? prsState.error : null;

  useEffect(() => {
    if (request.booting) return;
    const ctrl = new AbortController();
    const { api, project, currentUserName } = request;
    const scope = JSON.stringify([project, currentUserName]);

    if (currentUserName) {
      api.list({ project, currentUser: currentUserName, quickFilter: 'my-tasks', sortBy: 'priority', sortOrder: 'asc', limit: 5 }, ctrl.signal)
        .then(async priority => {
          if (ctrl.signal.aborted) return;
          setPriorityItems(priority.items);
          const recent = await api.list({ project, currentUser: currentUserName, quickFilter: 'my-tasks', sortBy: 'changedDate', sortOrder: 'desc', limit: 5 }, ctrl.signal);
          if (ctrl.signal.aborted) return;
          setRecentItems(recent.items);
          setTasksState({ request, error: null, successfulScope: scope });
        }).catch((e: any) => {
          if (ctrl.signal.aborted || e?.name === 'AbortError' || e?.isAbort) return;
          setTasksState(prev => ({ request, error: e?.message || 'Failed to load priority items', successfulScope: prev?.successfulScope }));
        });
    }

    api.pullRequests({ project, quickFilter: 'needs-my-review', status: 'active', limit: 5 }, ctrl.signal)
      .then(res => {
        if (ctrl.signal.aborted) return;
        setPendingPRs(res.items);
        setPrsState({ request, error: null, successfulScope: project });
      }, (e: any) => {
        if (ctrl.signal.aborted || e?.name === 'AbortError' || e?.isAbort) return;
        setPrsState(prev => ({ request, error: e?.message || 'Failed to load pending reviews', successfulScope: prev?.successfulScope }));
      });

    api.myHistoryTimeline({ limit: 5, project }, ctrl.signal)
      .then(res => {
        if (ctrl.signal.aborted) return;
        setRecentEvents(res.items);
        setHistoryState({ request, error: null, successfulScope: project });
      }, (e: any) => {
        if (ctrl.signal.aborted || e?.name === 'AbortError' || e?.isAbort) return;
        setHistoryState(prev => ({ request, error: null, successfulScope: prev?.successfulScope }));
      });

    api.teamActivitySummary(7, project, ctrl.signal)
      .then(res => {
        if (ctrl.signal.aborted) return;
        setTeamSnapshot(res);
        setTeamState({ request, error: null, successfulScope: project });
      }, (e: any) => {
        if (ctrl.signal.aborted || e?.name === 'AbortError' || e?.isAbort) return;
        setTeamState(prev => ({ request, error: null, successfulScope: prev?.successfulScope }));
      });
    return () => ctrl.abort();
  }, [request]);

  const scope = summary?.scope;
  const isScopeReady = !booting && !!currentUserName && (!loadingTasks || tasksAvailable) && typeof scope?.myTasks === 'number';
  const isPRReady = !booting && !prSummaryLoading && !prSummaryError && prSummary !== null;
  const prIdentityUnavailable = !!prSummary?.reviewerIdentityStatus && prSummary.reviewerIdentityStatus.groupMembership !== 'available';
  const prCacheStale = !!prSummary?.cacheStatus?.stale;
  const pipelineUnavailable = pipelineSummary?.cacheStatus?.outcome === 'failed' && !pipelineSummary.cacheStatus.lastSyncedAt;
  const deploymentCache = deploymentSummary?.cacheStatus;
  const formatCacheTime = (value: string) => new Date(value.endsWith('Z') ? value : `${value}Z`).toLocaleString();
  const deploymentState = getIntegrationState({
    loading: deploymentSummaryLoading,
    hasData: !!deploymentSummary,
    backendReachable: source !== 'lost',
    requestError: !!deploymentSummaryError,
    status: deploymentCache
  });
  const deploymentUnavailable = deploymentState === 'failed';
  const deploymentError = deploymentCache?.errors?.[0];
  const deploymentErrorNotice = deploymentError?.kind === 'auth'
    ? t('cache.auth', { status: deploymentError.status ?? '' })
    : deploymentError?.kind === 'rate_limited'
      ? t('cache.rateLimited')
      : deploymentError?.kind === 'timeout'
        ? t('cache.timeout')
        : deploymentError?.kind === 'connection_refused'
          ? t('cache.upstreamUnreachable')
          : deploymentError?.kind === 'upstream_http'
            ? t('cache.upstreamHttp', { status: deploymentError.status ?? '' })
            : null;
  const deploymentCacheNotice = deploymentState === 'cached'
    ? `${t('cache.stale', { when: deploymentCache?.lastSyncedAt ? formatCacheTime(deploymentCache.lastSyncedAt) : t('cache.unknownTime') })}${deploymentErrorNotice ? ` ${deploymentErrorNotice}` : ''}`
    : deploymentState === 'partial'
      ? `${t('cache.partial')}${deploymentCache?.stale && deploymentCache.lastSyncedAt ? ` ${t('cache.stale', { when: formatCacheTime(deploymentCache.lastSyncedAt) })}` : ''}${deploymentErrorNotice ? ` ${deploymentErrorNotice}` : ''}`
      : deploymentState === 'failed'
        ? `${t('cache.failed')}${deploymentErrorNotice ? ` ${deploymentErrorNotice}` : ''}`
        : deploymentState === 'unreachable'
          ? t('cache.unreachable')
          : null;

  const lastSyncText = syncIndicator?.lastSuccessAt
    ? new Date(syncIndicator.lastSuccessAt.endsWith('Z') ? syncIndicator.lastSuccessAt : syncIndicator.lastSuccessAt + 'Z').toLocaleTimeString()
    : null;

  const navigateTo = (view: ViewMode, qf?: 'my-tasks' | 'blocked' | 'all', myBlockedOnly?: boolean) => {
    if (qf) {
      setFilters(prev => ({
        ...prev,
        quickFilter: qf,
        selectedAssignees: myBlockedOnly && currentUserName ? [currentUserName] : []
      }));
    }
    setViewMode(view);
  };

  return (
    <div className="flex-1 flex min-h-0 bg-[#F8FAFC] dark:bg-[#0B0F17] overflow-hidden select-none">
      {/* Main Scrollable Canvas */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6">
        {/* Welcome Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 bg-white dark:bg-[#0E131F] p-5 sm:p-6 rounded-2xl border border-slate-200/90 dark:border-slate-800 shadow-2xs">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-brand-500" />
              <h1 data-testid="dashboard-welcome-title" className="min-w-0 whitespace-normal break-words font-bold text-lg sm:text-xl text-slate-900 dark:text-slate-100 tracking-tight">
                {t('welcome', { name: currentUserName || 'Developer' })}
              </h1>
            </div>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
              {t('subtitle')}
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={() => setRefreshNonce(n => n + 1)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={t('actions.refresh', { ns: 'common' })}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('actions.refresh', { ns: 'common' })}</span>
            </button>
          </div>
        </div>

        {/* 1. Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: My Active Tasks */}
          <div
            onClick={() => navigateTo('explorer', 'my-tasks')}
            data-testid="dash-card-my-tasks"
            className="group cursor-pointer p-5 rounded-2xl bg-white dark:bg-[#0E131F] border border-slate-200 dark:border-slate-800 hover:border-emerald-300 dark:hover:border-emerald-800/80 shadow-2xs hover:shadow-md transition-all flex flex-col justify-between"
          >
            <div className="flex items-start justify-between">
              <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold">
                <UserCheck className="w-5 h-5" />
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-emerald-500 transition-colors" />
            </div>
            <div className="mt-4 space-y-0.5">
              <span className="text-2xl font-extrabold text-slate-900 dark:text-slate-100">
                {isScopeReady ? scope.myTasks : '—'}
              </span>
              <div className="font-semibold text-xs text-slate-700 dark:text-slate-300">
                {t('cards.myTasks')}
              </div>
              <div className="text-[11px] text-slate-400 truncate">
                {t('cards.myTasksDesc')}
              </div>
            </div>
          </div>

          {/* Card 2: Blocked Tasks (Assigned to Me) */}
          <div
            onClick={() => navigateTo('explorer', 'blocked', true)}
            data-testid="dash-card-blocked"
            className="group cursor-pointer p-5 rounded-2xl bg-white dark:bg-[#0E131F] border border-slate-200 dark:border-slate-800 hover:border-rose-300 dark:hover:border-rose-800/80 shadow-2xs hover:shadow-md transition-all flex flex-col justify-between"
          >
            <div className="flex items-start justify-between">
              <div className="w-9 h-9 rounded-xl bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center font-bold">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-rose-500 transition-colors" />
            </div>
            <div className="mt-4 space-y-0.5">
              <span className="text-2xl font-extrabold text-slate-900 dark:text-slate-100">
                {isScopeReady ? (scope.myBlocked ?? 0) : '—'}
              </span>
              <div className="font-semibold text-xs text-slate-700 dark:text-slate-300">
                {t('cards.blockedTasks')}
              </div>
              <div className="text-[11px] text-slate-400 truncate">
                {t('cards.blockedTasksDesc')}
              </div>
            </div>
          </div>

          {/* Card 3: Pending PRs */}
          <div
            onClick={() => navigateTo('pull-requests')}
            data-testid="dash-card-pending-prs"
            className="group cursor-pointer p-5 rounded-2xl bg-white dark:bg-[#0E131F] border border-slate-200 dark:border-slate-800 hover:border-brand-300 dark:hover:border-brand-800/80 shadow-2xs hover:shadow-md transition-all flex flex-col justify-between"
          >
            <div className="flex items-start justify-between">
              <div className="w-9 h-9 rounded-xl bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 flex items-center justify-center font-bold">
                <GitPullRequest className="w-5 h-5" />
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-brand-500 transition-colors" />
            </div>
            <div className="mt-4 space-y-0.5">
              <span className="text-2xl font-extrabold text-slate-900 dark:text-slate-100">
                {isPRReady && !prIdentityUnavailable ? prSummary.needsMyReview : prSummaryError || prIdentityUnavailable ? '!' : '—'}
              </span>
              {prSummaryError && <span className="sr-only" data-testid="dash-pr-summary-error">{prSummaryError}</span>}
              <div className="font-semibold text-xs text-slate-700 dark:text-slate-300">
                {t('cards.pendingPRs')}
              </div>
              <div role={prSummaryError ? 'alert' : undefined} className="text-[11px] text-slate-400 truncate">
                {prSummaryError || (prIdentityUnavailable
                  ? t('cards.reviewerIdentityUnavailable')
                  : prCacheStale
                    ? t('cards.cachedPRs', { when: prSummary?.cacheStatus?.lastSyncedAt ? formatCacheTime(prSummary.cacheStatus.lastSyncedAt) : t('cache.unknownTime') })
                    : t('cards.pendingPRsDesc'))}
              </div>
            </div>
          </div>

          {/* Card 4: My Open PRs */}
          <div
            onClick={() => navigateTo('pull-requests')}
            data-testid="dash-card-my-prs"
            className="group cursor-pointer p-5 rounded-2xl bg-white dark:bg-[#0E131F] border border-slate-200 dark:border-slate-800 hover:border-sky-300 dark:hover:border-sky-800/80 shadow-2xs hover:shadow-md transition-all flex flex-col justify-between"
          >
            <div className="flex items-start justify-between">
              <div className="w-9 h-9 rounded-xl bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center font-bold">
                <GitBranch className="w-5 h-5" />
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-sky-500 transition-colors" />
            </div>
            <div className="mt-4 space-y-0.5">
              <span className="text-2xl font-extrabold text-slate-900 dark:text-slate-100">
                {isPRReady ? prSummary.createdByMe : prSummaryError ? '!' : '—'}
              </span>
              {prSummaryError && <span className="sr-only" data-testid="dash-pr-summary-error">{prSummaryError}</span>}
              <div className="font-semibold text-xs text-slate-700 dark:text-slate-300">
                {t('cards.myOpenPRs')}
              </div>
              <div role={prSummaryError ? 'alert' : undefined} className="text-[11px] text-slate-400 truncate">
                {prSummaryError || (prCacheStale
                  ? t('cards.cachedPRs', { when: prSummary?.cacheStatus?.lastSyncedAt ? formatCacheTime(prSummary.cacheStatus.lastSyncedAt) : t('cache.unknownTime') })
                  : t('cards.myOpenPRsDesc'))}
              </div>
            </div>
          </div>
        </div>

        {/* 2. Middle Work Area: Priority Work & Pending Reviews */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Priority Work Panel */}
          <div className="bg-white dark:bg-[#0E131F] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xs flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800/80">
              <div className="space-y-0.5 min-w-0">
                <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
                  {t('sections.priorityWork')}
                </h3>
                <p className="text-[11px] text-slate-400 truncate">{t('sections.priorityWorkDesc')}</p>
              </div>
              <button
                onClick={() => navigateTo('explorer', 'my-tasks')}
                className="text-xs font-semibold text-brand-600 dark:text-brand-400 hover:text-brand-700 flex items-center gap-1 shrink-0"
              >
                <span>{t('sections.viewAll')}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {loadingTasks && !tasksAvailable ? (
              <div className="py-12 flex justify-center text-slate-400">
                <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : errorTasks ? (
              <div className="p-4 text-center text-xs text-rose-500">
                {errorTasks}
              </div>
            ) : !currentUserName ? (
              <div className="py-10 text-center text-slate-400 text-xs">—</div>
            ) : priorityItems.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-xs italic flex flex-col items-center gap-2">
                <Inbox className="w-8 h-8 text-slate-300 dark:text-slate-700" />
                <span>{t('empty.noPriorityWork')}</span>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800/60 -mx-1">
                {priorityItems.map(item => (
                  <div
                    key={item.id}
                    onClick={() => setSelectedWorkItem(item)}
                    data-testid="dash-priority-item"
                    data-id={item.id}
                    className="p-2.5 px-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded-xl cursor-pointer transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <PriorityBadge priority={item.priority} />
                      <span className="font-mono text-xs font-bold text-slate-400 shrink-0">
                        #{item.id}
                      </span>
                      <span className="font-semibold text-xs text-slate-800 dark:text-slate-200 truncate" title={item.title}>
                        {item.title}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                        {stateLabel(t, item.state)}
                      </span>
                      <span className="text-[10px] text-slate-400 hidden sm:inline">{item.project}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pending PR Reviews Panel */}
          <div className="bg-white dark:bg-[#0E131F] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xs flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800/80">
              <div className="space-y-0.5 min-w-0">
                <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
                  {t('sections.pendingReviews')}
                </h3>
                <p className="text-[11px] text-slate-400 truncate">{t('sections.pendingReviewsDesc')}</p>
              </div>
              <button
                onClick={() => navigateTo('pull-requests')}
                className="text-xs font-semibold text-brand-600 dark:text-brand-400 hover:text-brand-700 flex items-center gap-1 shrink-0"
              >
                <span>{t('sections.viewAll')}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {loadingPRs && !prsAvailable ? (
              <div className="py-12 flex justify-center text-slate-400">
                <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : errorPRs ? (
              <div className="p-4 text-center text-xs text-rose-500">
                {errorPRs}
              </div>
            ) : !prsAvailable || pendingPRs.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-xs italic flex flex-col items-center gap-2">
                <Inbox className="w-8 h-8 text-slate-300 dark:text-slate-700" />
                <span>{t('empty.noPendingReviews')}</span>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800/60 -mx-1">
                {pendingPRs.map(pr => (
                  <div
                    key={pr.id}
                    onClick={() => setSelectedPR(pr)}
                    data-testid="dash-pr-item"
                    data-id={pr.id}
                    className="p-2.5 px-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded-xl cursor-pointer transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <GitPullRequest className="w-4 h-4 text-brand-500 shrink-0" />
                      <span className="font-mono text-xs font-bold text-slate-400 shrink-0">
                        #{pr.id}
                      </span>
                      <span className="font-semibold text-xs text-slate-800 dark:text-slate-200 truncate" title={pr.title}>
                        {pr.title}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-slate-400 font-mono truncate max-w-[100px]">
                        {pr.repository}
                      </span>
                      <span className="text-[10px] text-slate-400 font-medium">
                        {pr.authorName}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 3. CI/CD Health & Deployments Section */}
        <div className="space-y-3">
          <div>
            <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
              {t('sections.cicdHealth')}
            </h3>
            <p className="text-[11px] text-slate-400">{t('sections.cicdHealthDesc')}</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Pipelines Health Card */}
            <div data-testid="dash-pipeline-card" className="bg-white dark:bg-[#0E131F] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xs flex flex-col justify-between">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800/80">
                <div className="flex items-center gap-2">
                  <PlayCircle className="w-4 h-4 text-sky-500" />
                  <span className="font-bold text-xs text-slate-900 dark:text-slate-100">{t('sections.pipelineStatus')}</span>
                </div>
                <button
                  onClick={() => navigateTo('pipelines')}
                  className="text-xs font-semibold text-brand-600 dark:text-brand-400 hover:text-brand-700 flex items-center gap-1"
                >
                  <span>{t('sections.viewPipelines')}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 text-center">
                  <div className="text-[10px] text-slate-400">{t('summary.successRate', { ns: 'pipelines' })}</div>
                  <div className="text-base font-bold text-brand-600 dark:text-brand-400 mt-0.5">
                    {pipelineSummary && !pipelineUnavailable && pipelineSummary.totalRuns > 0 ? `%${pipelineSummary.successRate}` : '—'}
                  </div>
                </div>

                <div className="p-2.5 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-900/40 text-center">
                  <div className="text-[10px] text-emerald-700 dark:text-emerald-400">{t('summary.succeeded', { ns: 'pipelines' })}</div>
                  <div className="text-base font-bold text-emerald-700 dark:text-emerald-300 mt-0.5">
                    {pipelineSummary && !pipelineUnavailable ? pipelineSummary.succeeded : '—'}
                  </div>
                </div>

                <div className="p-2.5 rounded-xl bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-900/40 text-center">
                  <div className="text-[10px] text-rose-700 dark:text-rose-400">{t('summary.failed', { ns: 'pipelines' })}</div>
                  <div className="text-base font-bold text-rose-700 dark:text-rose-300 mt-0.5">
                    {pipelineSummary && !pipelineUnavailable ? pipelineSummary.failed : '—'}
                  </div>
                </div>
              </div>

              {/* Latest Broken Build Warning Banner or Health Status */}
              {pipelineSummaryLoading ? (
                <div className="py-2.5 flex items-center justify-center text-slate-400 gap-2 text-xs" data-testid="dash-pipeline-loading">
                  <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                  <span>{t('empty.loading', { ns: 'pipelines' })}</span>
                </div>
              ) : pipelineSummaryError ? (
                <div className="p-2.5 rounded-xl bg-rose-50/60 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 text-center text-xs text-rose-600 dark:text-rose-400">
                  {pipelineSummaryError}
                </div>
              ) : pipelineSummary?.cacheStatus?.outcome === 'partial' || pipelineSummary?.cacheStatus?.outcome === 'failed' || pipelineSummary?.cacheStatus?.stale ? (
                <div role="status" className="p-2.5 rounded-xl bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 text-center text-xs text-amber-700 dark:text-amber-300">
                  {pipelineSummary.cacheStatus.outcome === 'failed' ? t('cache.pipelineFailed') : pipelineSummary.cacheStatus.outcome === 'partial' ? t('cache.pipelinePartial') : t('cache.pipelineStale')}
                </div>
              ) : pipelineSummary?.totalRuns === 0 ? (
                <div role="status" className="p-2.5 text-center text-xs text-slate-500">{t('cache.pipelineEmpty')}</div>
              ) : pipelineSummary?.failedRuns && pipelineSummary.failedRuns.length > 0 ? (
                <div
                  onClick={() => setSelectedPipelineRun(pipelineSummary.failedRuns[0])}
                  className="p-3 rounded-xl bg-rose-50/80 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 flex items-center justify-between gap-2.5 cursor-pointer hover:border-rose-400 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0 text-xs">
                    <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="font-semibold text-rose-900 dark:text-rose-200 truncate">
                        {pipelineSummary.failedRuns[0].pipelineName}
                      </div>
                      <div className="text-[10px] text-rose-600 dark:text-rose-400 truncate">
                        {pipelineSummary.failedRuns[0].sourceBranch} • #{pipelineSummary.failedRuns[0].id}
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-rose-400 shrink-0" />
                </div>
              ) : pipelineSummary ? (
                <div className="p-2.5 rounded-xl bg-emerald-50/40 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-900/40 text-center text-xs text-emerald-700 dark:text-emerald-400 flex items-center justify-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span>{t('sections.noFailedPipelines')}</span>
                </div>
              ) : null}
            </div>

            {/* Deployments Overview Card */}
            <div data-testid="dash-deployment-card" className="bg-white dark:bg-[#0E131F] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xs flex flex-col justify-between">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800/80">
                <div className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-purple-500" />
                  <span className="font-bold text-xs text-slate-900 dark:text-slate-100">{t('sections.latestDeployment')}</span>
                </div>
                <button
                  onClick={() => navigateTo('deployments')}
                  className="text-xs font-semibold text-brand-600 dark:text-brand-400 hover:text-brand-700 flex items-center gap-1"
                >
                  <span>{t('sections.viewDeployments')}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 text-center">
                  <div className="text-[10px] text-slate-400">{t('summary.totalDeployments', { ns: 'deployments' })}</div>
                  <div className="text-base font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                    {deploymentSummary && !deploymentUnavailable ? deploymentSummary.totalDeployments : '—'}
                  </div>
                </div>

                <div className="p-2.5 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-900/40 text-center">
                  <div className="text-[10px] text-emerald-700 dark:text-emerald-400">{t('summary.succeeded', { ns: 'deployments' })}</div>
                  <div className="text-base font-bold text-emerald-700 dark:text-emerald-300 mt-0.5">
                    {deploymentSummary && !deploymentUnavailable ? deploymentSummary.succeeded : '—'}
                  </div>
                </div>

                <div className="p-2.5 rounded-xl bg-brand-50/50 dark:bg-brand-950/20 border border-brand-200/60 dark:border-brand-900/40 text-center">
                  <div className="text-[10px] text-brand-700 dark:text-brand-400">{t('summary.successRate', { ns: 'deployments' })}</div>
                  <div className="text-base font-bold text-brand-700 dark:text-brand-300 mt-0.5">
                    {deploymentSummary && !deploymentUnavailable ? `%${deploymentSummary.successRate}` : '—'}
                  </div>
                </div>
              </div>

              {/* Environment Distribution Chips or Status */}
              {deploymentSummaryLoading ? (
                <div className="py-2.5 flex items-center justify-center text-slate-400 gap-2 text-xs" data-testid="dash-deployment-loading">
                  <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                  <span>{t('empty.loading', { ns: 'deployments' })}{deploymentSummary?.lastSyncedAt ? ` · ${t('cache.stale', { when: formatCacheTime(deploymentSummary.lastSyncedAt) })}` : ''}</span>
                </div>
              ) : deploymentSummaryError ? (
                <div className="p-2.5 rounded-xl bg-rose-50/60 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 text-center text-xs text-rose-600 dark:text-rose-400">
                  {deploymentSummaryError}{deploymentSummary?.lastSyncedAt ? ` · ${t('cache.stale', { when: formatCacheTime(deploymentSummary.lastSyncedAt) })}` : ''}
                </div>
              ) : deploymentCacheNotice ? (
                <div role="status" className="p-2.5 rounded-xl bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 text-center text-xs text-amber-700 dark:text-amber-300">
                  {deploymentCacheNotice}
                </div>
              ) : deploymentSummary?.environments && deploymentSummary.environments.length > 0 ? (
                <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                  {deploymentSummary.environments.slice(0, 4).map(env => (
                    <div
                      key={env.name}
                      onClick={() => navigateTo('deployments')}
                      className="cursor-pointer px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-[11px] font-semibold flex items-center gap-1.5 hover:border-brand-400 transition-colors"
                    >
                      <span className="text-slate-700 dark:text-slate-300">{env.name}</span>
                      <span className="px-1 rounded bg-white dark:bg-slate-800 text-slate-500 font-mono text-[10px]">{env.total}</span>
                    </div>
                  ))}
                </div>
              ) : deploymentSummary ? (
                <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 text-center text-xs text-slate-400">
                  {t('sections.noDeployments')}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* 4. Activity Insights (Personal History & Team Activity Snapshot) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* My Recent Activity Card */}
          <div data-testid="dash-my-history-card" className="bg-white dark:bg-[#0E131F] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800/80">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-emerald-500" />
                  <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
                    {t('sections.myRecentActivity')}
                  </h3>
                </div>
                <p className="text-[11px] text-slate-400">{t('sections.myRecentActivityDesc')}</p>
              </div>
              <button
                onClick={() => navigateTo('my-history')}
                className="text-xs font-semibold text-brand-600 dark:text-brand-400 hover:text-brand-700 flex items-center gap-1 shrink-0"
              >
                <span>{t('sections.viewHistory')}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {loadingHistory && !historyAvailable ? (
              <div className="py-6 flex justify-center text-slate-400">
                <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : !historyAvailable || recentEvents.length === 0 ? (
              <div className="py-6 text-center text-slate-400 text-xs italic">
                {t('sections.noRecentPersonalActivity')}
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800/60 -mx-1">
                {recentEvents.map(ev => (
                  <div
                    key={ev.id}
                    onClick={() => {
                      if (ev.entity.type === 'workItem' && typeof ev.entity.id === 'number') {
                        api.item(ev.entity.id).then(it => it && setSelectedWorkItem(it)).catch(() => ev.url && window.open(ev.url, '_blank'));
                      } else if (ev.url) {
                        window.open(ev.url, '_blank');
                      }
                    }}
                    className="p-2 px-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded-xl cursor-pointer transition-colors flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {ev.eventType.includes('commit') ? (
                        <GitCommit className="w-3.5 h-3.5 text-brand-500 shrink-0" />
                      ) : ev.eventType.includes('pullRequest') ? (
                        <GitPullRequest className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      )}
                      <span className="font-semibold text-slate-800 dark:text-slate-200 truncate" title={ev.summary}>
                        {ev.summary}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0">
                      {ev.occurredAt ? new Date(ev.occurredAt).toLocaleDateString() : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Team Activity Snapshot Card */}
          <div data-testid="dash-team-activity-card" className="bg-white dark:bg-[#0E131F] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xs flex flex-col justify-between">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800/80">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-cyan-500" />
                  <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
                    {t('sections.teamActivitySnapshot')}
                  </h3>
                </div>
                <p className="text-[11px] text-slate-400">
                  {t('sections.teamActivitySnapshotDesc')} ({filters.selectedProject === 'all' ? t('projects.all', { ns: 'common' }) : filters.selectedProject})
                </p>
              </div>
              <button
                onClick={() => navigateTo('team-activity')}
                className="text-xs font-semibold text-brand-600 dark:text-brand-400 hover:text-brand-700 flex items-center gap-1 shrink-0"
              >
                <span>{t('sections.viewTeam')}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {loadingTeam && !teamAvailable ? (
              <div className="py-6 flex justify-center text-slate-400">
                <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : !teamAvailable || !teamSnapshot ? (
              <div className="py-6 text-center text-slate-400 text-xs italic">
                {t('sections.noTeamActivity')}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800">
                    <div className="text-[10px] text-slate-400">{t('columns.commits', { ns: 'teamActivity' })}</div>
                    <div className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-0.5">{teamSnapshot.totalCommits}</div>
                  </div>
                  <div className="p-2 rounded-xl bg-brand-50/50 dark:bg-brand-950/20 border border-brand-200/60 dark:border-brand-900/40">
                    <div className="text-[10px] text-brand-700 dark:text-brand-400">{t('columns.authoredPRs', { ns: 'teamActivity' })}</div>
                    <div className="text-sm font-bold text-brand-700 dark:text-brand-300 mt-0.5">{teamSnapshot.totalPRs}</div>
                  </div>
                  <div className="p-2 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-200/60 dark:border-indigo-900/40">
                    <div className="text-[10px] text-indigo-700 dark:text-indigo-400">{t('summary.activeContributors', { ns: 'teamActivity' })}</div>
                    <div className="text-sm font-bold text-indigo-700 dark:text-indigo-300 mt-0.5">{teamSnapshot.activeContributors}</div>
                  </div>
                </div>

                {/* Top 3 Active Contributors */}
                {teamSnapshot.contributors?.length > 0 && (
                  <div className="space-y-1 pt-1">
                    {teamSnapshot.contributors.slice(0, 3).map((c, i) => (
                      <div key={c.name} className="flex items-center justify-between text-xs px-2 py-1 rounded-lg bg-slate-50/60 dark:bg-slate-900/40">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-bold text-[10px] text-slate-400">#{i + 1}</span>
                          <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">{c.name}</span>
                        </div>
                        <span className="text-[10px] font-mono font-bold text-slate-600 dark:text-slate-400">
                          {c.commitCount} commits • {c.authoredPRs} PR
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 5. Bottom Row: Recent Activity & Quick Navigation */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Recent Updated Tasks (2 cols on lg) */}
          <div className="lg:col-span-2 bg-white dark:bg-[#0E131F] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800/80">
              <div className="space-y-0.5">
                <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
                  {t('sections.recentActivity')}
                </h3>
                <p className="text-[11px] text-slate-400">{t('sections.recentActivityDesc')}</p>
              </div>
              {lastSyncText && (
                <span className="text-[11px] font-mono text-slate-400 bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-800 shrink-0">
                  {t('sections.lastSync', { time: lastSyncText })}
                </span>
              )}
            </div>

            {loadingTasks && !tasksAvailable ? (
              <div className="py-8 flex justify-center text-slate-400">
                <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : !currentUserName ? (
              <div className="py-8 text-center text-slate-400 text-xs">—</div>
            ) : !tasksAvailable || recentItems.length === 0 ? (
              <div className="py-8 text-center text-slate-400 text-xs italic">
                {t('empty.noRecentActivity')}
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800/60 -mx-1">
                {recentItems.map(item => (
                  <div
                    key={item.id}
                    onClick={() => setSelectedWorkItem(item)}
                    className="p-2.5 px-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded-xl cursor-pointer transition-colors flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <TypeBadge type={item.type} />
                      <span className="font-mono text-xs font-bold text-slate-400 shrink-0">
                        #{item.id}
                      </span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200 truncate" title={item.title}>
                        {item.title}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-slate-400 text-[11px] shrink-0 font-mono">
                      <Clock className="w-3 h-3" />
                      <span>{item.changedDate ? new Date(item.changedDate).toLocaleDateString() : '—'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick Navigation Panel */}
          <div className="bg-white dark:bg-[#0E131F] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-3 shadow-2xs flex flex-col justify-between">
            <div className="space-y-0.5 pb-2 border-b border-slate-100 dark:border-slate-800/80">
              <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
                {t('sections.quickNav')}
              </h3>
            </div>

            <div className="space-y-2">
              <button
                onClick={() => navigateTo('explorer', 'my-tasks')}
                className="w-full flex items-center justify-between p-2.5 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950/60 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-emerald-500" />
                  <span>{t('quickActions.goToTasks')}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => navigateTo('explorer', 'blocked', true)}
                className="w-full flex items-center justify-between p-2.5 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/60 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-500" />
                  <span>{t('quickActions.goToBlocked')}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => navigateTo('board')}
                className="w-full flex items-center justify-between p-2.5 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950/60 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Kanban className="w-4 h-4 text-brand-500" />
                  <span>{t('quickActions.goToKanban')}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => navigateTo('dependencies')}
                className="w-full flex items-center justify-between p-2.5 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950/60 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Network className="w-4 h-4 text-sky-500" />
                  <span>{t('quickActions.goToDependencies')}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => navigateTo('pull-requests')}
                className="w-full flex items-center justify-between p-2.5 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950/60 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <GitPullRequest className="w-4 h-4 text-purple-500" />
                  <span>{t('quickActions.goToPRs')}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => navigateTo('pipelines')}
                className="w-full flex items-center justify-between p-2.5 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950/60 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <PlayCircle className="w-4 h-4 text-sky-500" />
                  <span>{t('quickActions.goToPipelines')}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => navigateTo('deployments')}
                className="w-full flex items-center justify-between p-2.5 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950/60 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-purple-500" />
                  <span>{t('quickActions.goToDeployments')}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => navigateTo('team-activity')}
                className="w-full flex items-center justify-between p-2.5 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950/60 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-cyan-500" />
                  <span>{t('quickActions.goToTeam')}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => navigateTo('my-history')}
                className="w-full flex items-center justify-between p-2.5 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950/60 text-xs font-semibold text-slate-700 dark:text-slate-300 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-emerald-500" />
                  <span>{t('quickActions.goToHistory')}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Slide-over Work Item Inspector Drawer */}
      {selectedWorkItem && (
        <WorkItemInspector
          item={selectedWorkItem}
          onClose={() => setSelectedWorkItem(null)}
          onNavigateToItem={item => setSelectedWorkItem(item)}
        />
      )}

      {/* Slide-over Pull Request Inspector Drawer */}
      {selectedPR && (
        <PullRequestInspector
          pr={selectedPR}
          onClose={() => setSelectedPR(null)}
        />
      )}

      {/* Slide-over Pipeline Run Inspector Drawer */}
      {selectedPipelineRun && (
        <PipelineInspector
          run={selectedPipelineRun}
          onClose={() => setSelectedPipelineRun(null)}
        />
      )}

      {/* Slide-over Deployment Inspector Drawer */}
      {selectedDeployment && (
        <DeploymentInspector
          deployment={selectedDeployment}
          onClose={() => setSelectedDeployment(null)}
        />
      )}
    </div>
  );
};
