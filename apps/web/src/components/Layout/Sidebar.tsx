import React, { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Layers,
  Kanban,
  GitFork,
  Network,
  UserCheck,
  Inbox,
  AlertTriangle,
  FolderGit2,
  ChevronLeft,
  Sun,
  Moon,
  LayoutDashboard,
  GitPullRequest,
  PlayCircle,
  Server,
  Users,
  History,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import { useApp } from '../../context/useApp';
import { UserAvatar } from '../Common/UserAvatar';
import { BrandLogo } from '../Common/BrandLogo';
import type { ViewMode } from '../../types';
import {
  SIDEBAR_STORAGE_KEY,
  parseSidebarPref,
  resolveSidebarCollapsed,
  type SidebarPref
} from '../../utils/layout';

const readSidebarPref = (): SidebarPref => {
  try {
    return parseSidebarPref(localStorage.getItem(SIDEBAR_STORAGE_KEY));
  } catch {
    return null;
  }
};

export const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const {
    viewMode,
    setViewMode,
    filters,
    setFilters,
    summary,
    prSummary,
    pipelineSummary,
    projects,
    theme,
    toggleTheme,
    booting,
    currentUserName
  } = useApp();

  // An explicit user choice (persisted) wins; without one the rail follows the viewport width.
  const [pref, setPref] = useState<SidebarPref>(readSidebarPref);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1920 : window.innerWidth
  );
  const collapsed = resolveSidebarCollapsed(pref, viewportWidth);
  const autoCollapsed = pref === null && collapsed;

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setCollapsed = (next: boolean) => {
    const value: SidebarPref = next ? 'collapsed' : 'expanded';
    setPref(value);
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, value);
    } catch {
      /* storage unavailable: the choice still applies for this session */
    }
  };

  // One source of truth for every counter: the server summary for the selected project scope. The Task Explorer and
  // the Kanban tabs read the very same object, and their lists use the same server predicates.
  const scope = summary?.scope;

  const SIDEBAR_GROUPS_KEY = 'devopsflow_sidebar_groups';
  const readSidebarGroups = (): Record<string, boolean> => {
    try {
      const raw = localStorage.getItem(SIDEBAR_GROUPS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { overview: true, workManagement: true, codeAndCiCd: true, analytics: true };
  };

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(readSidebarGroups);

  const toggleGroup = (groupId: string) => {
    setOpenGroups(prev => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      try {
        localStorage.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const navGroups: {
    id: string;
    labelKey: string;
    items: { id: ViewMode; label: string; icon: React.ReactNode; count?: number }[];
  }[] = [
    {
      id: 'overview',
      labelKey: 'views.navGroups.overview',
      items: [
        {
          id: 'dashboard',
          label: t('views.dashboard'),
          icon: <LayoutDashboard className="w-4 h-4" />
        }
      ]
    },
    {
      id: 'workManagement',
      labelKey: 'views.navGroups.workManagement',
      items: [
        {
          id: 'explorer',
          label: t('views.explorer'),
          icon: <Layers className="w-4 h-4" />,
          count: scope?.total
        },
        {
          id: 'board',
          label: t('views.board'),
          icon: <Kanban className="w-4 h-4" />
        },
        {
          id: 'hierarchy',
          label: t('views.hierarchy'),
          icon: <GitFork className="w-4 h-4" />
        },
        {
          id: 'dependencies',
          label: t('views.dependencies'),
          icon: <Network className="w-4 h-4" />
        }
      ]
    },
    {
      id: 'codeAndCiCd',
      labelKey: 'views.navGroups.codeAndCiCd',
      items: [
        {
          id: 'pull-requests',
          label: t('views.pullRequests'),
          icon: <GitPullRequest className="w-4 h-4" />,
          count: prSummary?.needsMyReview
        },
        {
          id: 'pipelines',
          label: t('views.pipelines'),
          icon: <PlayCircle className="w-4 h-4" />,
          count: pipelineSummary?.failed && pipelineSummary.failed > 0 ? pipelineSummary.failed : undefined
        },
        {
          id: 'deployments',
          label: t('views.deployments'),
          icon: <Server className="w-4 h-4" />
        }
      ]
    },
    {
      id: 'analytics',
      labelKey: 'views.navGroups.analytics',
      items: [
        {
          id: 'my-history',
          label: t('views.myHistory'),
          icon: <History className="w-4 h-4" />
        },
        {
          id: 'team-activity',
          label: t('views.teamActivity'),
          icon: <Users className="w-4 h-4" />
        }
      ]
    }
  ];

  // Reopen the destination group on navigation, while allowing the user to
  // close the current group explicitly.
  const [previousView, setPreviousView] = useState<ViewMode | null>(null);
  if (previousView !== viewMode) {
    setPreviousView(viewMode);
    const activeGroup = navGroups.find(g => g.items.some(i => i.id === viewMode));
    if (activeGroup && !openGroups[activeGroup.id]) {
      setOpenGroups({ ...openGroups, [activeGroup.id]: true });
    }
  }

  // Global counts priority
  const isScopeReady = !booting && summary !== null && scope !== undefined;
  const unassignedCount = isScopeReady ? scope.unassigned : undefined;
  const myTasksCount = isScopeReady ? scope.myTasks : undefined;
  const blockedCount = isScopeReady ? scope.blocked : undefined;

  const handleQuickFilter = (qf: 'all' | 'my-tasks' | 'unassigned' | 'blocked') => {
    setViewMode('explorer');
    setFilters(prev => ({ ...prev, quickFilter: qf }));
  };

  // Projects section collapsible & search
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');

  const handleProjectSelect = (proj: string) => {
    setFilters(prev => ({ ...prev, selectedProject: proj }));
  };

  const filteredProjects = useMemo(() => {
    if (!projectSearch.trim()) return projects;
    const q = projectSearch.toLowerCase();
    return projects.filter(p => p.name.toLowerCase().includes(q));
  }, [projects, projectSearch]);

  return (
    <aside
      className={`relative flex flex-col border-r border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#0E131F] transition-all duration-200 z-30 select-none ${
        collapsed ? 'w-16 min-w-[64px]' : 'w-64 min-w-[256px]'
      }`}
    >
      {/* Brand Header */}
      <div
        className={`h-[68px] border-b border-slate-200 dark:border-slate-800/80 flex items-center transition-all ${
          collapsed ? 'justify-center px-0' : 'justify-between px-3.5'
        }`}
      >
        {!collapsed ? (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-3 pr-2">
              <BrandLogo className="h-8 w-8 shrink-0" aria-hidden="true" />
              <div className="flex min-w-0 flex-col justify-center gap-0.5">
                <span className="shrink-0 text-sm font-semibold leading-5 tracking-tight text-slate-900 dark:text-white">
                  {t('appName')}
                </span>
                <span className="whitespace-nowrap text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                  {t('appSubtitle')}
                </span>
              </div>
            </div>

            <button
              onClick={() => setCollapsed(true)}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
              title={t('sidebar.collapse')}
              aria-label={t('sidebar.collapse')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </>
        ) : (
          <button
            onClick={() => setCollapsed(false)}
            className="w-10 h-10 rounded-xl flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800/70 transition-all group"
            title={autoCollapsed ? `${t('sidebar.expand')} (${t('sidebar.autoCollapsed')})` : t('sidebar.expand')}
            aria-label={t('sidebar.expand')}
          >
            <BrandLogo className="h-8 w-8 transition-transform group-hover:scale-95" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Navigation Sections */}
      <div className="flex-1 overflow-y-auto px-2 space-y-4 py-3">
        {/* Navigation Groups */}
        <div className="space-y-3">
          {navGroups.map((group, groupIdx) => {
            const isOpen = openGroups[group.id] ?? true;

            return (
              <div key={group.id} className="space-y-1">
                {/* Collapsed mode group divider */}
                {collapsed && groupIdx > 0 && (
                  <div className="w-8 mx-auto my-1.5 h-px bg-slate-200 dark:bg-slate-800" />
                )}

                {/* Expanded mode collapsible group header */}
                {!collapsed && (
                  <button
                    onClick={() => toggleGroup(group.id)}
                    aria-expanded={isOpen}
                    className="w-full flex items-center justify-between px-2 py-1 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider hover:text-slate-700 dark:hover:text-slate-300 transition-colors group select-none"
                  >
                    <span className="truncate">{t(group.labelKey)}</span>
                    <span className="text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300">
                      {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </span>
                  </button>
                )}

                {/* Group items (shown if open or if sidebar is collapsed) */}
                {(collapsed || isOpen) && (
                  <div className="space-y-0.5">
                    {group.items.map(item => {
                      const active = viewMode === item.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => setViewMode(item.id)}
                          aria-current={active ? 'page' : undefined}
                          className={`transition-all ${
                            collapsed
                              ? 'w-10 h-10 mx-auto rounded-lg flex items-center justify-center relative'
                              : 'w-full flex items-center gap-2.5 px-2.5 py-1.5 text-xs font-medium rounded-md'
                          } ${
                            active
                              ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/80 dark:text-brand-300 font-semibold shadow-2xs'
                              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/40'
                          }`}
                          title={collapsed ? `${item.label} (${item.count || ''})` : undefined}
                          aria-label={item.label}
                          data-testid={`nav-${item.id}`}
                        >
                          <span className={`shrink-0 ${active ? 'text-brand-600 dark:text-brand-400' : ''}`}>
                            {item.icon}
                          </span>

                          {!collapsed && (
                            <>
                              <span className="flex-1 text-left truncate">{item.label}</span>
                              {typeof item.count === 'number' && (
                                <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full font-semibold ${
                                  active
                                    ? 'bg-brand-100 dark:bg-brand-900 text-brand-700 dark:text-brand-300'
                                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                                }`}>
                                  {item.count}
                                </span>
                              )}
                            </>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Smart Focus Filters */}
        <div className="space-y-1">
          {!collapsed && (
            <span className="px-2 text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider block mb-1">
              {t('workFocus.title')}
            </span>
          )}

          {/* My Tasks */}
          <button
            onClick={() => handleQuickFilter('my-tasks')}
            className={`transition-all ${
              collapsed
                ? 'w-10 h-10 mx-auto rounded-lg flex items-center justify-center relative'
                : 'w-full flex items-center gap-2.5 px-2.5 py-1.5 text-xs font-medium rounded-md'
            } ${
              filters.quickFilter === 'my-tasks' && viewMode === 'explorer'
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 font-semibold shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/40'
            }`}
            title={collapsed ? `${t('workFocus.myTasks')} (${myTasksCount})` : undefined}
            aria-label={t('workFocus.myTasks')}
          >
            <UserCheck className="w-4 h-4 text-emerald-500 shrink-0" />
            {!collapsed ? (
              <>
                <span className="flex-1 text-left truncate">{t('workFocus.myTasks')}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 font-semibold">
                  {isScopeReady ? myTasksCount : '—'}
                </span>
              </>
            ) : (
              (myTasksCount ?? 0) > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-emerald-500" />
              )
            )}
          </button>

          {/* Blocked Items */}
          <button
            onClick={() => handleQuickFilter('blocked')}
            className={`transition-all ${
              collapsed
                ? 'w-10 h-10 mx-auto rounded-lg flex items-center justify-center relative'
                : 'w-full flex items-center gap-2.5 px-2.5 py-1.5 text-xs font-medium rounded-md'
            } ${
              filters.quickFilter === 'blocked' && viewMode === 'explorer'
                ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 font-semibold shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/40'
            }`}
            title={collapsed ? `${t('workFocus.blocked')} (${isScopeReady ? blockedCount : '—'})` : undefined}
            aria-label={t('workFocus.blocked')}
          >
            <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
            {!collapsed ? (
              <>
                <span className="flex-1 text-left truncate">{t('workFocus.blocked')}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-400 font-semibold">
                  {isScopeReady ? blockedCount : '—'}
                </span>
              </>
            ) : (
              (blockedCount ?? 0) > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500" />
              )
            )}
          </button>

          {/* Unassigned Pool */}
          <button
            onClick={() => handleQuickFilter('unassigned')}
            className={`transition-all ${
              collapsed
                ? 'w-10 h-10 mx-auto rounded-lg flex items-center justify-center relative'
                : 'w-full flex items-center gap-2.5 px-2.5 py-1.5 text-xs font-medium rounded-md'
            } ${
              filters.quickFilter === 'unassigned' && viewMode === 'explorer'
                ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 font-semibold shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/40'
            }`}
            title={collapsed ? `${t('workFocus.unassigned')} (${isScopeReady ? unassignedCount : '—'})` : undefined}
            aria-label={t('workFocus.unassigned')}
          >
            <Inbox className="w-4 h-4 text-amber-500 shrink-0" />
            {!collapsed ? (
              <>
                <span className="flex-1 text-left truncate">{t('workFocus.unassigned')}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 font-semibold">
                  {isScopeReady ? unassignedCount : '—'}
                </span>
              </>
            ) : (
              (unassignedCount ?? 0) > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-500" />
              )
            )}
          </button>
        </div>

        {/* Project Quick Access (Collapsible) */}
        <div className="space-y-1">
          {!collapsed ? (
            <div className="space-y-1">
              <button
                onClick={() => setProjectsExpanded(v => !v)}
                aria-expanded={projectsExpanded}
                className="w-full flex items-center justify-between px-2 py-1 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider hover:text-slate-700 dark:hover:text-slate-300 transition-colors group select-none"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <FolderGit2 className="w-3.5 h-3.5 text-slate-400" />
                  <span className="truncate">{t('projects.title')} ({projects.length})</span>
                </div>
                <div className="flex items-center gap-1">
                  {filters.selectedProject !== 'all' && (
                    <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-brand-50 dark:bg-brand-950 text-brand-600 dark:text-brand-400 truncate max-w-[80px]">
                      {filters.selectedProject}
                    </span>
                  )}
                  <span className="text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300">
                    {projectsExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  </span>
                </div>
              </button>

              {projectsExpanded && (
                <div className="space-y-1 pt-1">
                  {projects.length > 5 && (
                    <div className="px-1 pb-1">
                      <input
                        type="text"
                        value={projectSearch}
                        onChange={e => setProjectSearch(e.target.value)}
                        placeholder={t('projects.searchPlaceholder', { defaultValue: 'Proje filtrele...' })}
                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded px-2 py-1 text-[11px] text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>
                  )}

                  <div className="max-h-48 overflow-y-auto space-y-0.5 pr-0.5">
                    <button
                      onClick={() => handleProjectSelect('all')}
                      className={`w-full flex items-center gap-2 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                        filters.selectedProject === 'all'
                          ? 'bg-brand-50 dark:bg-brand-950/80 text-brand-700 dark:text-brand-300 font-semibold shadow-2xs'
                          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/30'
                      }`}
                    >
                      <span className="flex-1 text-left truncate">{t('projects.all')}</span>
                    </button>

                    {filteredProjects.map(({ name: proj, total: projTotal }: { name: string; total: number }) => {
                      const isSelected = filters.selectedProject === proj;
                      return (
                        <button
                          key={proj}
                          onClick={() => handleProjectSelect(proj)}
                          title={proj}
                          className={`w-full flex items-center gap-2 px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                            isSelected
                              ? 'bg-brand-50 dark:bg-brand-950/80 text-brand-700 dark:text-brand-300 font-semibold shadow-2xs'
                              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/30'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSelected ? 'bg-brand-500' : 'bg-slate-400'}`} />
                          <span className="flex-1 text-left truncate">{proj}</span>
                          {isScopeReady && (
                            <span className="text-[10px] font-mono text-slate-400">
                              {projTotal}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800/60">
              <button
                onClick={() => setCollapsed(false)}
                className="w-10 h-10 mx-auto rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
                title={filters.selectedProject !== 'all' ? `${t('projects.title')}: ${filters.selectedProject}` : t('projects.expandTitle', { count: projects.length })}
              >
                <FolderGit2 className="w-4 h-4 shrink-0" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Footer / User Profile & Theme toggle */}
      <div className="p-2 border-t border-slate-200 dark:border-slate-800/80 bg-slate-50/50 dark:bg-[#0A0E17]/60">
        {!collapsed ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 overflow-hidden">
              <UserAvatar name={currentUserName} size="md" className="w-7 h-7 text-xs" />
              <div className="flex flex-col truncate">
                <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                  {currentUserName}
                </span>
                <span className="text-[10px] text-slate-400">Azure DevOps</span>
              </div>
            </div>

            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition-colors shrink-0"
              title={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-1">
            <UserAvatar name={currentUserName} size="lg" className="w-8 h-8 text-xs" />
            <button
              onClick={toggleTheme}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition-colors"
              title={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};
