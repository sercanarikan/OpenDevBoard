import React, { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import { Sidebar } from './components/Layout/Sidebar';
import { Header } from './components/Layout/Header';
import { NotFoundView } from './components/Common/NotFoundView';
import { CommandPalette } from './components/CommandPalette/CommandPalette';

const DashboardOverview = lazy(() => import('./components/Dashboard/DashboardOverview').then((module) => ({ default: module.DashboardOverview })));
const TaskExplorer = lazy(() => import('./components/Explorer/TaskExplorer').then((module) => ({ default: module.TaskExplorer })));
const KanbanBoard = lazy(() => import('./components/Kanban/KanbanBoard').then((module) => ({ default: module.KanbanBoard })));
const HierarchyView = lazy(() => import('./components/Hierarchy/HierarchyView').then((module) => ({ default: module.HierarchyView })));
const DependencyExplorer = lazy(() => import('./components/Dependencies/DependencyExplorer').then((module) => ({ default: module.DependencyExplorer })));
const PullRequestExplorer = lazy(() => import('./components/PullRequests/PullRequestExplorer').then((module) => ({ default: module.PullRequestExplorer })));
const PipelineExplorer = lazy(() => import('./components/Pipelines/PipelineExplorer').then((module) => ({ default: module.PipelineExplorer })));
const DeploymentExplorer = lazy(() => import('./components/Deployments/DeploymentExplorer').then((module) => ({ default: module.DeploymentExplorer })));
const TeamActivityExplorer = lazy(() => import('./components/TeamActivity/TeamActivityExplorer').then((module) => ({ default: module.TeamActivityExplorer })));
const MyHistoryTimeline = lazy(() => import('./components/MyHistory/MyHistoryTimeline').then((module) => ({ default: module.MyHistoryTimeline })));

class RouteLoadErrorBoundary extends React.Component<React.PropsWithChildren, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="flex flex-1 items-center justify-center p-6 text-sm text-slate-600 dark:text-slate-300">
          <div className="max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-semibold text-slate-900 dark:text-white">Sayfa yüklenemedi</h2>
            <p className="mt-1">Bu sayfa şu anda yüklenemiyor. Lütfen sayfayı yenileyin veya başka bir bölüme geçin.</p>
            <button className="mt-4 rounded-md bg-slate-900 px-3 py-2 text-white dark:bg-slate-100 dark:text-slate-900" onClick={() => window.location.reload()}>
              Sayfayı yenile
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const API_BASE_URL = '/api';

const MainContent: React.FC = () => {
  const { t } = useTranslation();
  const {
    isDemo,
    source,
    connectionError,
    isBannerDismissed,
    retryConnection,
    dismissConnectionBanner
  } = useApp();

  // Demo (backend was never reachable) and lost (backend went away after a successful start) are different
  // situations; both are announced, neither is ever presented as live data.
  const showBanner = (isDemo || source === 'lost') && !!connectionError && !isBannerDismissed;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 font-sans">
      {/* Collapsible Sidebar */}
      <Sidebar />

      {/* Main Viewport Container */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <Header />

        {/* Live API offline / Demo Mode banner */}
        {showBanner && (
          <div
            role="alert"
            data-testid="connection-banner"
            data-source={source}
            className="bg-amber-500/10 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/60 px-4 py-2 flex items-center justify-between text-xs text-amber-900 dark:text-amber-200 shrink-0 select-none animate-in slide-in-from-top-1 duration-150"
          >
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="truncate">
                <strong>{source === 'lost' ? t('status.unreachable') : t('status.offlineBannerTitle')}:</strong>{' '}
                {source === 'lost'
                  ? t('status.unreachableTooltip')
                  : t('status.offlineBannerDesc', { endpoint: API_BASE_URL, error: connectionError })}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-3">
              <button
                onClick={retryConnection}
                data-testid="banner-retry"
                className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white font-medium rounded text-[11px] transition-colors cursor-pointer"
              >
                {t('status.retryConnection')}
              </button>
              <button
                onClick={dismissConnectionBanner}
                aria-label={t('actions.close')}
                className="text-amber-700 dark:text-amber-400 hover:text-amber-950 dark:hover:text-amber-100 p-0.5 rounded cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* View Router */}
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <RouteLoadErrorBoundary>
            <Suspense
              fallback={(
                <div role="status" className="flex flex-1 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
                  Yükleniyor…
                </div>
              )}
            >
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardOverview />} />
                <Route path="/tasks" element={<TaskExplorer />} />
                <Route path="/kanban" element={<KanbanBoard />} />
                <Route path="/hierarchy" element={<HierarchyView />} />
                <Route path="/dependencies" element={<DependencyExplorer />} />
                <Route path="/pull-requests" element={<PullRequestExplorer />} />
                <Route path="/pipelines" element={<PipelineExplorer />} />
                <Route path="/deployments" element={<DeploymentExplorer />} />
                <Route path="/team-activity" element={<TeamActivityExplorer />} />
                <Route path="/my-history" element={<MyHistoryTimeline />} />
                {/* Backward compatibility aliases */}
                <Route path="/explorer" element={<Navigate to="/tasks" replace />} />
                <Route path="/board" element={<Navigate to="/kanban" replace />} />
                <Route path="*" element={<NotFoundView />} />
              </Routes>
            </Suspense>
          </RouteLoadErrorBoundary>
        </main>
      </div>

      {/* Linear/Raycast Style Global Command Palette */}
      <CommandPalette />
    </div>
  );
};

export function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <MainContent />
      </AppProvider>
    </BrowserRouter>
  );
}

export default App;
