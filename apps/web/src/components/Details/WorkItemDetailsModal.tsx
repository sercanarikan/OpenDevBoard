import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  ExternalLink,
  GitBranch,
  ArrowDownLeft,
  ArrowUpRight,
  Link2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Layers,
  FolderGit2,
  ChevronRight
} from 'lucide-react';
import { useApp } from '../../context/useApp';
import { TypeBadge, StateBadge, PriorityBadge } from '../Common/Badge';
import { UserAvatar } from '../Common/UserAvatar';

export const WorkItemDetailsModal: React.FC = () => {
  const { t } = useTranslation();
  const {
    selectedWorkItem,
    setSelectedWorkItem,
    openWorkItem,
    poolData
  } = useApp();

  if (!selectedWorkItem) return null;

  const item = selectedWorkItem;
  const allItems = poolData?.flat_items || [];

  // Find parent item if exists
  const parentItem = item.parentId ? allItems.find(i => i.id === item.parentId) : null;

  // Find children of this item
  const children = allItems.filter(i => i.parentId === item.id);
  const completedChildren = children.filter(c =>
    c.state === 'Closed' || c.state === 'Done' || c.state === 'Resolved'
  );
  const progressPercent = children.length > 0 ? Math.round((completedChildren.length / children.length) * 100) : 0;

  // Function to navigate directly to another work item within the drawer
  const navigateToItem = (targetId: number) => {
    const target = allItems.find(i => i.id === targetId);
    if (target) {
      setSelectedWorkItem(target);
    } else {
      void openWorkItem(targetId);
    }
  };

  const formatDate = (isoString?: string) => {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return d.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex justify-end"
      onClick={() => setSelectedWorkItem(null)}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-[#101726] h-full shadow-2xl border-l border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden animate-in slide-in-from-right duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="h-14 px-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0 bg-slate-50/70 dark:bg-[#0E131F]">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-sm font-semibold text-slate-500 dark:text-slate-400">
              #{item.id}
            </span>
            <TypeBadge type={item.type} size="md" />
            <StateBadge state={item.state} size="md" />
          </div>

          <div className="flex items-center gap-2">
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-400 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md border border-slate-200 dark:border-slate-700 transition-colors"
              title={t('inspector.openInDevops')}
            >
              <span>Azure DevOps</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>

            <button
              onClick={() => setSelectedWorkItem(null)}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-800 transition-colors"
              title={t('details.closeDrawer')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Blocked Warning Banner */}
          {item.isBlocked && (
            <div className="p-3.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
              <div className="text-xs">
                <span className="font-semibold text-rose-800 dark:text-rose-300 block">
                  {t('chip.modalBlocked')}
                </span>
                <span className="text-rose-700 dark:text-rose-400">
                  {t('details.blockedDesc')}
                </span>
              </div>
            </div>
          )}

          {/* Title */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white leading-snug">
              {item.title}
            </h2>

            {/* Project & Iteration Tags */}
            <div className="flex items-center gap-3 mt-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1">
                <FolderGit2 className="w-3.5 h-3.5 text-slate-400" />
                <span>{item.project}</span>
              </span>
              {item.iteration && (
                <>
                  <span>•</span>
                  <span>{item.iteration}</span>
                </>
              )}
              {item.areaPath && (
                <>
                  <span>•</span>
                  <span>{item.areaPath}</span>
                </>
              )}
            </div>
          </div>

          {/* Metadata Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200/80 dark:border-slate-800 text-xs">
            {/* Assignee */}
            <div>
              <span className="text-slate-400 block text-[11px] mb-1">{t('fields.assignee')}</span>
              {item.isUnassigned ? (
                <span className="text-amber-600 dark:text-amber-400 font-medium">{t('fields.unassigned')}</span>
              ) : (
                <div className="flex items-center gap-1.5">
                  <UserAvatar name={item.assignedTo} avatarUrl={item.assignedAvatar} size="xs" />
                  <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                    {item.assignedTo}
                  </span>
                </div>
              )}
            </div>

            {/* Priority */}
            <div>
              <span className="text-slate-400 block text-[11px] mb-1">{t('fields.priority')}</span>
              <PriorityBadge priority={item.priority} />
            </div>

            {/* Story Points */}
            <div>
              <span className="text-slate-400 block text-[11px] mb-1">{t('fields.storyPoints')}</span>
              <span className="font-mono font-medium text-slate-800 dark:text-slate-200">
                {item.storyPoints ? t('fields.storyPointsValue', { value: item.storyPoints }) : '—'}
              </span>
            </div>

            {/* Updated Date */}
            <div>
              <span className="text-slate-400 block text-[11px] mb-1">{t('details.lastUpdated')}</span>
              <span className="font-mono text-[11px] text-slate-700 dark:text-slate-300">
                {formatDate(item.changedDate)}
              </span>
            </div>
          </div>

          {/* Description */}
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              {t('fields.description')}
            </h4>
            <div className="p-3.5 rounded-lg bg-slate-50/70 dark:bg-slate-900/40 border border-slate-200/80 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
              {item.description || t('details.noDescription')}
            </div>
          </div>

          {/* Hierarchy: Parent & Children Section */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
              <span>{t('details.hierarchy')}</span>
              <GitBranch className="w-3.5 h-3.5" />
            </h4>

            {/* Parent Card */}
            {parentItem ? (
              <div
                onClick={() => navigateToItem(parentItem.id)}
                className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 hover:border-brand-500 hover:shadow-xs cursor-pointer transition-all flex items-center justify-between gap-3 group"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-[10px] uppercase font-bold text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                    {t('details.parent')}
                  </span>
                  <TypeBadge type={parentItem.type} size="sm" />
                  <span className="font-mono text-xs text-slate-400">#{parentItem.id}</span>
                  <span className="text-xs font-medium text-slate-900 dark:text-slate-100 group-hover:text-brand-600 dark:group-hover:text-brand-400 truncate">
                    {parentItem.title}
                  </span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-brand-500 shrink-0" />
              </div>
            ) : item.parentId ? (
              <div className="p-2.5 rounded-md bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 text-xs text-slate-500">
                {t('details.externalParent', { id: item.parentId })}
              </div>
            ) : (
              <div className="text-xs text-slate-400 italic">
                {t('inspector.topLevel')}
              </div>
            )}

            {/* Children Tasks / PBIs */}
            {children.length > 0 && (
              <div className="space-y-2 pt-1">
                {/* Progress bar */}
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {t('details.childItems', { done: completedChildren.length, total: children.length })}
                  </span>
                  <span className="font-mono font-semibold text-brand-600 dark:text-brand-400">
                    {progressPercent}%
                  </span>
                </div>

                <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-300 rounded-full"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>

                {/* Children List */}
                <div className="divide-y divide-slate-100 dark:divide-slate-800/60 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 overflow-hidden text-xs">
                  {children.map(child => (
                    <div
                      key={child.id}
                      onClick={() => navigateToItem(child.id)}
                      className="p-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <TypeBadge type={child.type} size="sm" />
                        <span className="font-mono text-slate-400 text-[11px]">#{child.id}</span>
                        <span className="font-medium text-slate-800 dark:text-slate-200 group-hover:text-brand-600 dark:group-hover:text-brand-400 truncate">
                          {child.title}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[11px] text-slate-400">
                          {child.assignedTo || t('fields.unassigned')}
                        </span>
                        <StateBadge state={child.state} size="sm" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Visual Dependency Matrix (Predecessors & Successors) */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
              <span>{t('details.dependencyMatrix')}</span>
              <Layers className="w-3.5 h-3.5" />
            </h4>

            {/* Predecessors (Must be finished first) */}
            <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-400">
                <ArrowDownLeft className="w-4 h-4" />
                <span>{t('fields.predecessors')}</span>
                <span className="font-mono text-[11px] px-1.5 py-0.2 rounded bg-indigo-100 dark:bg-indigo-950/80">
                  {item.relations?.predecessors?.length || 0}
                </span>
              </div>

              {item.relations?.predecessors?.length > 0 ? (
                <div className="space-y-1.5">
                  {item.relations.predecessors.map(pred => {
                    const isResolved = pred.state === 'Closed' || pred.state === 'Resolved' || pred.state === 'Done';
                    return (
                      <div
                        key={pred.id}
                        onClick={() => navigateToItem(pred.id)}
                        className="p-2.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-400 cursor-pointer transition-all flex items-center justify-between text-xs gap-3 group"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-[11px] text-indigo-600 dark:text-indigo-400 font-semibold">
                            #{pred.id}
                          </span>
                          {pred.type && <TypeBadge type={pred.type} size="sm" />}
                          <span className="font-medium text-slate-800 dark:text-slate-200 group-hover:text-indigo-600 truncate">
                            {pred.title || t('fallback.workItem', { id: pred.id })}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {isResolved ? (
                            <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                              <CheckCircle2 className="w-3 h-3" /> {t('details.resolved')}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                              <Clock className="w-3 h-3" /> {t('chip.blockingThis')}
                            </span>
                          )}
                          {pred.state && <StateBadge state={pred.state} size="sm" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-slate-400 italic">{t('inspector.noPredecessors')}</p>
              )}
            </div>

            {/* Successors (Waiting for this task) */}
            <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-700 dark:text-cyan-400">
                <ArrowUpRight className="w-4 h-4" />
                <span>{t('fields.successors')}</span>
                <span className="font-mono text-[11px] px-1.5 py-0.2 rounded bg-cyan-100 dark:bg-cyan-950/80">
                  {item.relations?.successors?.length || 0}
                </span>
              </div>

              {item.relations?.successors?.length > 0 ? (
                <div className="space-y-1.5">
                  {item.relations.successors.map(succ => (
                    <div
                      key={succ.id}
                      onClick={() => navigateToItem(succ.id)}
                      className="p-2.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-cyan-400 cursor-pointer transition-all flex items-center justify-between text-xs gap-3 group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[11px] text-cyan-600 dark:text-cyan-400 font-semibold">
                          #{succ.id}
                        </span>
                        {succ.type && <TypeBadge type={succ.type} size="sm" />}
                        <span className="font-medium text-slate-800 dark:text-slate-200 group-hover:text-cyan-600 truncate">
                          {succ.title || t('fallback.workItem', { id: succ.id })}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {succ.state && <StateBadge state={succ.state} size="sm" />}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400 italic">{t('inspector.noSuccessors')}</p>
              )}
            </div>

            {/* Related Items */}
            {item.relations?.related?.length > 0 && (
              <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <Link2 className="w-4 h-4" />
                  <span>{t('details.related', { count: item.relations.related.length })}</span>
                </div>

                <div className="space-y-1.5">
                  {item.relations.related.map(rel => (
                    <div
                      key={rel.id}
                      onClick={() => navigateToItem(rel.id)}
                      className="p-2.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-400 cursor-pointer transition-all flex items-center justify-between text-xs gap-3 group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[11px] text-slate-500 font-semibold">
                          #{rel.id}
                        </span>
                        {rel.type && <TypeBadge type={rel.type} size="sm" />}
                        <span className="font-medium text-slate-800 dark:text-slate-200 group-hover:text-brand-600 truncate">
                          {rel.title || t('fallback.workItem', { id: rel.id })}
                        </span>
                      </div>
                      {rel.state && <StateBadge state={rel.state} size="sm" />}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
