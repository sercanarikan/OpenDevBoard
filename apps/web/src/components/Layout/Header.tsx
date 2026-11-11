import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  Search,
  ExternalLink,
  Wifi,
  WifiOff,
  SlidersHorizontal,
  FolderGit2,
  Database,
  AlertTriangle,
  MoreHorizontal
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { getHeaderTitleKey } from '../../utils/routeState';
import { LanguageSelector } from '../Common/LanguageSelector';

export const Header: React.FC = () => {
  const { t, i18n } = useTranslation();
  const {
    viewMode,
    filters,
    setFilters,
    source,
    booting,
    connectionError,
    retryConnection,
    summary,
    projects,
    syncReport,
    syncIndicator,
    isSyncing,
    triggerSync,
    setIsCommandPaletteOpen,
    density,
    toggleDensity
  } = useApp();

  const getViewTitle = () => {
    const specialTitleKey = getHeaderTitleKey(viewMode);
    if (specialTitleKey) return t(specialTitleKey);

    switch (viewMode) {
      case 'dashboard':
        return t('views.dashboard');
      case 'explorer':
        return t('views.explorer');
      case 'board':
        return t('views.board');
      case 'hierarchy':
        return t('views.hierarchy');
      case 'dependencies':
        return t('views.dependencies');
      case 'pull-requests':
        return t('views.pullRequests');
      case 'pipelines':
        return t('views.pipelines');
      case 'deployments':
        return t('views.deployments');
      case 'team-activity':
        return t('views.teamActivity');
      case 'my-history':
        return t('views.myHistory');
      default:
        return t('views.explorer');
    }
  };

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const handleProjectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters(prev => ({ ...prev, selectedProject: e.target.value }));
  };

  // The org snapshot (WIQL count at the last sync) is informational only; it is never a screen counter.
  const ind = syncIndicator;
  const syncLabel =
    ind.kind === 'syncing' ? t('status.syncInProgress')
    : ind.kind === 'failed' ? (ind.partial ? t('status.syncPartial') : t('status.syncFailed'))
    : ind.kind === 'demo' ? t('status.demoMode')
    : ind.kind === 'fixture' ? t('status.fixtureData')
    : ind.kind === 'unreachable' ? t('status.unreachable')
    : t('status.cachedData');
  const lastSyncText = ind.lastSuccessAt
    ? new Date(ind.lastSuccessAt.endsWith('Z') ? ind.lastSuccessAt : ind.lastSuccessAt + 'Z').toLocaleTimeString(i18n.language?.startsWith('en') ? 'en-GB' : 'tr-TR', { hour: '2-digit', minute: '2-digit' })
    : null;
  const syncTooltip = [
    ind.kind === 'failed' ? t('status.syncFailedDesc') : t('status.cachedTooltip'),
    lastSyncText ? `${t('status.lastSuccessfulSync')}: ${lastSyncText}` : t('status.neverSynced'),
    ind.error ? `(${ind.error})` : ''
  ].filter(Boolean).join(' ');
  const totalActive = projects.reduce((n, p) => n + p.total, 0);
  const isTotalReady = !booting && summary !== null;
  const allTotalLabel = isTotalReady ? (filters.selectedProject === 'all' ? summary.scope.total : totalActive) : '—';
  const orgSnapshot = syncReport?.totalOrgActive || 0;

  const densityLabel = t('density.' + density);
  const densityButton = (
    <button
      onClick={toggleDensity}
      className={`p-1.5 rounded-md border text-xs flex items-center gap-1 transition-colors ${
        density === 'compact'
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-300'
          : 'border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
      }`}
      title={`${t('density.toggleDensity')}: ${densityLabel}`}
      aria-label={t('density.toggleDensity')}
      data-testid="header-density"
    >
      <SlidersHorizontal className="w-3.5 h-3.5" />
      <span className="text-[11px] font-medium hidden sm:inline capitalize">{densityLabel}</span>
    </button>
  );

  const openInDevopsLink = (
    <a
      href="https://dev.azure.com"
      target="_blank"
      rel="noopener noreferrer"
      className="p-1.5 rounded-md border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
      title={t('actions.openInDevops')}
      aria-label={t('actions.openInDevops')}
    >
      <ExternalLink className="w-3.5 h-3.5" />
    </a>
  );

  return (
    <header
      data-testid="header"
      className="h-14 border-b border-slate-200 dark:border-slate-800/80 bg-white/95 dark:bg-[#0B0F17]/90 backdrop-blur-md px-4 flex items-center gap-3 sticky top-0 z-20 select-none min-w-0"
    >
      {/* Left: View title + Project Selector */}
      <div className="flex items-center gap-3 min-w-0 shrink max-w-[45%]">
        <h1 data-testid="header-page-title" className="font-semibold text-sm text-slate-900 dark:text-white tracking-tight whitespace-nowrap shrink-0">
          {getViewTitle()}
        </h1>

        <div className="h-4 w-px bg-slate-200 dark:bg-slate-800 shrink-0" />

        {/* Project selector dropdown */}
        <div className="hidden min-[480px]:flex items-center gap-1.5 min-w-0 text-xs text-slate-600 dark:text-slate-300">
          <FolderGit2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <select
            value={filters.selectedProject}
            onChange={handleProjectChange}
            aria-label={t('projects.all')}
            title={orgSnapshot > 0 ? t('projects.orgSnapshot', { loaded: totalActive, org: orgSnapshot }) : undefined}
            className="min-w-0 max-w-[220px] truncate bg-transparent font-medium text-xs text-slate-800 dark:text-slate-200 focus:outline-none cursor-pointer border-none py-0.5 pr-2"
          >
            <option value="all" className="bg-white dark:bg-slate-900">
              {t('projects.all')} ({allTotalLabel})
            </option>
            {projects.map(p => (
              <option key={p.name} value={p.name} className="bg-white dark:bg-slate-900">
                {p.name} {isTotalReady ? `(${p.total})` : ''}
              </option>
            ))}
            {filters.selectedProject !== 'all' && !projects.some(p => p.name === filters.selectedProject) && (
              <option value={filters.selectedProject} className="bg-white dark:bg-slate-900">
                {filters.selectedProject}
              </option>
            )}
          </select>
        </div>
      </div>

      {/* Center: Command Palette Trigger (icon-only below 1200px) */}
      <div className="flex-1 flex justify-center min-w-0 max-w-md mx-auto">
        <button
          onClick={() => setIsCommandPaletteOpen(true)}
          className="flex items-center gap-2 px-2 min-[1200px]:px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/60 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs text-slate-500 dark:text-slate-400 transition-colors whitespace-nowrap"
          title={`${t('actions.commandMenu')} (⌘K)`}
          aria-label={t('actions.commandMenu')}
        >
          <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span className="font-medium hidden min-[1200px]:inline">{t('actions.commandMenu')}</span>
          <kbd className="hidden min-[1200px]:inline px-1.5 py-0.5 text-[10px] font-mono rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-400">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Right: Sync status, source, Language, Mode, Density, Refresh */}
      <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
        {/* Data source + sync state. Live, cached, syncing, failed, unreachable, fixture and demo are always distinct. */}
        <div
          className={`hidden lg:flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border whitespace-nowrap ${
            ind.kind === 'failed'
              ? 'border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300'
              : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 text-slate-600 dark:text-slate-400'
          }`}
          title={syncTooltip}
          data-testid="sync-indicator"
          data-state={ind.kind}
          role="status"
          aria-live="polite"
        >
          {ind.kind === 'syncing' ? (
            <RefreshCw className="w-3 h-3 animate-spin text-brand-500 shrink-0" />
          ) : ind.kind === 'failed' ? (
            <AlertTriangle className="w-3 h-3 text-rose-500 shrink-0" />
          ) : (
            <Database className="w-3 h-3 text-slate-400 shrink-0" />
          )}
          {/* Full label on wide screens; compact label with the same tooltip below 1280px */}
          <span className="font-medium whitespace-nowrap min-[1280px]:hidden">{t('status.syncShort')}</span>
          <span className="font-medium whitespace-nowrap hidden min-[1280px]:inline">{syncLabel}</span>
          {lastSyncText && ind.kind !== 'demo' && (
            <span className="font-mono text-slate-400 whitespace-nowrap hidden min-[1280px]:inline" data-testid="last-sync">
              · {lastSyncText}
            </span>
          )}
        </div>

        {/* Backend status pill: always visible */}
        {booting ? (
          <div className="px-2.5 py-1 rounded-full text-[11px] font-medium border border-slate-200 dark:border-slate-800 text-slate-500 shrink-0">
            …
          </div>
        ) : source === 'live' ? (
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border whitespace-nowrap shrink-0 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/50"
            title={t('status.liveTooltip')}
            data-testid="source-pill"
            data-source="live"
            aria-label={t('status.live')}
          >
            <Wifi className="w-3 h-3 text-emerald-500 shrink-0" />
            <span className="hidden min-[420px]:inline">{t('status.live')}</span>
          </div>
        ) : source === 'fixture' ? (
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border whitespace-nowrap shrink-0 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-900/50"
            title={t('status.fixtureTooltip')}
            data-testid="source-pill"
            data-source="fixture"
            aria-label={t('status.fixtureData')}
          >
            <Database className="w-3 h-3 text-sky-500 shrink-0" />
            <span className="hidden min-[420px]:inline">{t('status.fixtureData')}</span>
          </div>
        ) : source === 'lost' ? (
          <button
            onClick={retryConnection}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border whitespace-nowrap shrink-0 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900/50 hover:bg-rose-100 dark:hover:bg-rose-900/60 transition-colors cursor-pointer"
            title={`${t('status.unreachableTooltip')}${connectionError ? ' ' + connectionError : ''}`}
            data-testid="source-pill"
            data-source="lost"
            aria-label={t('status.unreachable')}
          >
            <WifiOff className="w-3 h-3 text-rose-500 shrink-0" />
            <span className="hidden min-[420px]:inline">{t('status.unreachable')}</span>
          </button>
        ) : (
          <button
            onClick={retryConnection}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border whitespace-nowrap shrink-0 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900/50 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors cursor-pointer"
            title={
              connectionError
                ? `${t('status.offlineBannerTitle')}: ${connectionError}. ${t('status.retryConnection')}.`
                : `${t('status.demoTooltip')}`
            }
            data-testid="source-pill"
            data-source="demo"
            aria-label={t('status.demoMode')}
          >
            <WifiOff className="w-3 h-3 text-amber-500 shrink-0" />
            <span className="hidden min-[420px]:inline">{t('status.demoMode')}</span>
          </button>
        )}

        {/* Wide screens: language, density and the Azure link stay inline */}
        <div className="hidden min-[1100px]:flex items-center gap-2.5 shrink-0">
          <LanguageSelector />
          {densityButton}
          {openInDevopsLink}
        </div>

        {/* Refresh / Incremental Sync trigger (always visible) */}
        <button
          onClick={() => triggerSync('incremental')}
          disabled={booting || isSyncing || source === 'demo'}
          className="p-1.5 rounded-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors disabled:opacity-50 cursor-pointer shrink-0"
          title={source === 'demo' ? t('status.demoTooltip') : t('status.syncNow')}
          aria-label={t('status.syncNow')}
          data-testid="sync-now"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncing || ind.kind === 'syncing' ? 'animate-spin text-brand-500' : ''}`} />
        </button>

        {/* Narrow screens: secondary actions collapse into one menu */}
        <div className="relative min-[1100px]:hidden shrink-0" ref={moreRef}>
          <button
            ref={moreButtonRef}
            type="button"
            onClick={() => setMoreOpen(o => !o)}
            aria-label={t('actions.more')}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-controls="header-more-menu"
            title={t('actions.more')}
            data-testid="header-more"
            className="p-1.5 rounded-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {moreOpen && (
            <div
              id="header-more-menu"
              role="menu"
              data-testid="header-more-menu"
              className="absolute right-0 top-full mt-1.5 w-56 rounded-xl bg-white dark:bg-[#121929] border border-slate-200 dark:border-slate-800 shadow-xl p-2 z-30 flex flex-col items-stretch gap-1.5"
            >
              <div role="menuitem" className="flex">
                <LanguageSelector />
              </div>
              <div role="menuitem" className="flex">
                {densityButton}
              </div>
              <div role="menuitem" className="flex">
                {openInDevopsLink}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
