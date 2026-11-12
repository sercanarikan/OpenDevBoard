import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Layers, Kanban, GitFork, Network, User, AlertCircle, ArrowRight, CornerDownLeft, X, LayoutDashboard, GitPullRequest, PlayCircle, Server, Users, History } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { WorkItem } from '../../types';
import { TypeBadge, StateBadge } from '../Common/Badge';
import { useDebounced } from '../../hooks/useDebounced';
import { createLatestRunner } from '../../utils/latestRunner';

export const CommandPalette: React.FC = () => {
  const { isCommandPaletteOpen } = useApp();
  return isCommandPaletteOpen ? <OpenCommandPalette /> : null;
};

const OpenCommandPalette: React.FC = () => {
  const { t } = useTranslation();
  const {
    setIsCommandPaletteOpen,
    api,
    booting,
    filters,
    currentUserName,
    setSelectedWorkItem,
    setViewMode,
    setFilters
  } = useApp();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Work item search runs on the server across ALL records (not only an already-loaded page), debounced, and a late
  // response of an older query can never overwrite a newer one.
  const debouncedQuery = useDebounced(query.trim(), 200);
  const [found, setFound] = useState<WorkItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const runnerRef = useRef(createLatestRunner());

  useEffect(() => {
    if (booting) return;
    runnerRef.current.run(
      signal =>
        api.list(
          {
            search: debouncedQuery,
            limit: debouncedQuery === '' ? 8 : 15,
            offset: 0,
            project: filters.selectedProject,
            currentUser: currentUserName,
            sortBy: 'changedDate',
            sortOrder: 'desc'
          },
          signal
        ),
      {
        onStart: () => {
          setSearching(true);
          setSearchError(false);
        },
        onSuccess: res => setFound(res.items),
        onError: () => setSearchError(true),
        onSettled: () => setSearching(false)
      }
    );
  }, [booting, api, debouncedQuery, currentUserName, filters.selectedProject]);

  useEffect(() => {
    const runner = runnerRef.current;
    return () => runner.cancel();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  const filteredItems: WorkItem[] = found;

  const navigationActions: { label: string; icon: React.ReactNode; action: () => void }[] = [
    {
      label: t('views.dashboard'),
      icon: <LayoutDashboard className="w-4 h-4 text-emerald-500" />,
      action: () => setViewMode('dashboard')
    },
    {
      label: t('command.switchExplorer'),
      icon: <Layers className="w-4 h-4 text-brand-500" />,
      action: () => setViewMode('explorer')
    },
    {
      label: t('command.switchBoard'),
      icon: <Kanban className="w-4 h-4 text-indigo-500" />,
      action: () => setViewMode('board')
    },
    {
      label: t('command.switchHierarchy'),
      icon: <GitFork className="w-4 h-4 text-purple-500" />,
      action: () => setViewMode('hierarchy')
    },
    {
      label: t('command.switchDependencies'),
      icon: <Network className="w-4 h-4 text-cyan-500" />,
      action: () => setViewMode('dependencies')
    },
    {
      label: t('views.pullRequests'),
      icon: <GitPullRequest className="w-4 h-4 text-rose-500" />,
      action: () => setViewMode('pull-requests')
    },
    {
      label: t('views.pipelines'),
      icon: <PlayCircle className="w-4 h-4 text-sky-500" />,
      action: () => setViewMode('pipelines')
    },
    {
      label: t('views.deployments'),
      icon: <Server className="w-4 h-4 text-purple-500" />,
      action: () => setViewMode('deployments')
    },
    {
      label: t('views.teamActivity'),
      icon: <Users className="w-4 h-4 text-cyan-500" />,
      action: () => setViewMode('team-activity')
    },
    {
      label: t('views.myHistory'),
      icon: <History className="w-4 h-4 text-emerald-500" />,
      action: () => setViewMode('my-history')
    },
    {
      label: t('command.myTasksOnly'),
      icon: <User className="w-4 h-4 text-emerald-500" />,
      action: () => {
        setViewMode('explorer');
        setFilters(f => ({ ...f, quickFilter: 'my-tasks' }));
      }
    },
    {
      label: t('command.unassignedPool'),
      icon: <AlertCircle className="w-4 h-4 text-amber-500" />,
      action: () => {
        setViewMode('explorer');
        setFilters(f => ({ ...f, quickFilter: 'unassigned' }));
      }
    }
  ];

  const filteredActions = query.trim() === ''
    ? navigationActions
    : navigationActions.filter(a => a.label.toLowerCase().includes(query.toLowerCase()));

  const totalResults = filteredActions.length + filteredItems.length;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % Math.max(1, totalResults));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + totalResults) % Math.max(1, totalResults));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex < filteredActions.length) {
        filteredActions[selectedIndex].action();
        setIsCommandPaletteOpen(false);
      } else {
        const itemIndex = selectedIndex - filteredActions.length;
        if (filteredItems[itemIndex]) {
          setSelectedWorkItem(filteredItems[itemIndex]);
          setIsCommandPaletteOpen(false);
        }
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-start justify-center pt-20 px-4"
      onClick={() => setIsCommandPaletteOpen(false)}
    >
      <div
        data-testid="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('command.quickActions')}
        className="w-full max-w-2xl bg-white dark:bg-[#111726] rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[75vh] animate-in fade-in zoom-in-95 duration-150"
        onClick={e => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div className="flex items-center px-4 py-3 border-b border-slate-200 dark:border-slate-800 gap-3">
          <Search className="w-5 h-5 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('command.placeholder')}
            className="w-full bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
          />
          <button
            onClick={() => setIsCommandPaletteOpen(false)}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="flex-1 overflow-y-auto p-2 divide-y divide-slate-100 dark:divide-slate-800/40">
          {/* Quick Actions */}
          {filteredActions.length > 0 && (
            <div className="py-1">
              <div className="px-2.5 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                {t('command.quickActions')}
              </div>
              {filteredActions.map((action, idx) => {
                const isSelected = selectedIndex === idx;
                return (
                  <button
                    key={action.label}
                    onClick={() => {
                      action.action();
                      setIsCommandPaletteOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors text-left ${
                      isSelected
                        ? 'bg-brand-50 text-brand-900 dark:bg-brand-950/60 dark:text-brand-200 font-medium'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      {action.icon}
                      <span>{action.label}</span>
                    </div>
                    {isSelected && (
                      <span className="flex items-center gap-1 text-[11px] text-brand-600 dark:text-brand-400 font-mono">
                        {t('command.select')} <CornerDownLeft className="w-3 h-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Work Items */}
          {filteredItems.length > 0 && (
            <div className="py-1">
              <div className="px-2.5 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                {t('command.workItems', { count: filteredItems.length })}
              </div>
              {filteredItems.map((item, idx) => {
                const itemOverallIndex = filteredActions.length + idx;
                const isSelected = selectedIndex === itemOverallIndex;

                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSelectedWorkItem(item);
                      setIsCommandPaletteOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors text-left gap-3 ${
                      isSelected
                        ? 'bg-brand-50 text-brand-900 dark:bg-brand-950/60 dark:text-brand-200'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <span className="font-mono text-xs text-slate-400 shrink-0">
                        #{item.id}
                      </span>
                      <TypeBadge type={item.type} size="sm" />
                      <span className="font-medium truncate text-slate-800 dark:text-slate-200">
                        {item.title}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-slate-400 hidden sm:inline">
                        {item.project}
                      </span>
                      <StateBadge state={item.state} size="sm" />
                      {isSelected ? (
                        <ArrowRight className="w-3.5 h-3.5 text-brand-500" />
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {searching && filteredItems.length === 0 && (
            <div className="py-6 text-center text-slate-400 text-xs" data-testid="palette-searching">
              {t('explorer.updating')}
            </div>
          )}

          {searchError && (
            <div className="py-6 text-center text-rose-600 dark:text-rose-400 text-xs" role="alert" data-testid="palette-error">
              {t('explorer.loadFailedTitle')}
            </div>
          )}

          {!searching && !searchError && totalResults === 0 && (
            <div className="py-10 text-center text-slate-400 text-xs">
              {t('command.noResults', { query })}
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0E131F] flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-3">
            <span>{t('command.navigate')}</span>
            <span>{t('command.enter')}</span>
            <span>{t('command.escClose')}</span>
          </div>
          <span>OpenDevBoard Palette</span>
        </div>
      </div>
    </div>
  );
};
