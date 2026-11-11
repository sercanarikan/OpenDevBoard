import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  ExternalLink,
  GitBranch,
  ArrowDownLeft,
  ArrowUpRight,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FolderGit2,
  ChevronRight,
  Crosshair
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { WorkItem } from '../../types';
import { isWorkItemCompleted, getWorkItemStateCategory } from '../../utils/workState';
import { UserAvatar } from '../Common/UserAvatar';
import { stateLabel } from '../../i18n/labels';

interface WorkItemInspectorProps {
  item: WorkItem;
  onClose: () => void;
  onNavigateToItem: (item: WorkItem) => void;
  onSetFocus?: (item: WorkItem) => void;
  isFocusedInGraph?: boolean;
}

export const WorkItemInspector: React.FC<WorkItemInspectorProps> = ({
  item,
  onClose,
  onNavigateToItem,
  onSetFocus,
  isFocusedInGraph
}) => {
  const { t } = useTranslation();
  const { api, refreshToken } = useApp();

  // The Inspector never depends on what a list currently shows: parent, children and relation targets are loaded by
  // id from the API (parents/children may be completed or outside the active scope and are not on any page).
  const [parentItem, setParentItem] = useState<WorkItem | null>(null);
  const [children, setChildren] = useState<WorkItem[]>([]);
  const [childrenTruncated, setChildrenTruncated] = useState(false);
  const [related, setRelated] = useState<Map<number, WorkItem>>(new Map());
  const [loadingRel, setLoadingRel] = useState(false);

  const relationIds = React.useMemo(() => {
    const ids = new Set<number>();
    for (const p of item.relations?.predecessors || []) ids.add(p.id);
    for (const sx of item.relations?.successors || []) ids.add(sx.id);
    return Array.from(ids).sort((a, b) => a - b);
  }, [item.relations]);
  const relationKey = relationIds.join(',');

  useEffect(() => {
    const ctrl = new AbortController();
    setLoadingRel(true);
    setParentItem(null);
    setChildren([]);
    setChildrenTruncated(false);

    const wanted = new Set<number>(relationIds);
    if (item.parentId) wanted.add(item.parentId);

    Promise.allSettled([
      wanted.size ? api.batch(Array.from(wanted), ctrl.signal) : Promise.resolve({ items: [] as WorkItem[], missing: [], dataVersion: '' }),
      api.children(item.id, ctrl.signal)
    ]).then(([batchRes, childRes]) => {
      if (ctrl.signal.aborted) return;
      if (batchRes.status === 'fulfilled') {
        const map = new Map(batchRes.value.items.map(i => [i.id, i]));
        setRelated(map);
        setParentItem(item.parentId ? map.get(item.parentId) || null : null);
      }
      if (childRes.status === 'fulfilled') {
        setChildren(childRes.value.items);
        setChildrenTruncated(!!childRes.value.truncated);
      }
      setLoadingRel(false);
    });

    return () => ctrl.abort();
    // relationKey is the stable identity of relationIds
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, item.id, item.parentId, relationKey, refreshToken]);

  const completedChildren = children.filter(c =>
    isWorkItemCompleted(c.state, c.type)
  );
  const percentComplete = children.length > 0
    ? Math.round((completedChildren.length / children.length) * 100)
    : 0;

  // Type dot color helper
  const getTypeDotColor = (type: string) => {
    const t = type.toLowerCase();
    if (t.includes('bug')) return 'bg-rose-500';
    if (t.includes('epic')) return 'bg-purple-500';
    if (t.includes('feature')) return 'bg-indigo-500';
    if (t.includes('story') || t.includes('pbi')) return 'bg-sky-500';
    return 'bg-emerald-500';
  };

  return (
    <aside className="w-full sm:w-[360px] md:w-[380px] lg:w-[400px] xl:w-[420px] h-full border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E1422] flex flex-col shrink-0 overflow-hidden shadow-lg lg:shadow-none animate-in slide-in-from-right duration-150 select-none">
      {/* Inspector Header */}
      <div className="h-14 px-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0 bg-slate-50/70 dark:bg-slate-900/40">
        <div className="flex items-center gap-2.5">
          <span className="font-mono font-bold text-slate-800 dark:text-slate-200 text-sm">
            #{item.id}
          </span>
          <span className="text-slate-300 dark:text-slate-700">•</span>
          <span className="inline-flex items-center gap-1.5 font-medium text-xs text-slate-700 dark:text-slate-300">
            <span className={`w-2 h-2 rounded-full ${getTypeDotColor(item.type)}`} />
            {item.type}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-slate-200/60 dark:hover:bg-slate-800 rounded-md border border-slate-200 dark:border-slate-700 transition-colors"
            title={t('inspector.openInDevops')}
          >
            <span>Azure DevOps</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
            title={t('inspector.closeTitle')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Inspector Content */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5" data-testid="inspector" data-id={item.id} aria-busy={loadingRel}>
        {/* Graph Focus Action (when onSetFocus is provided in Dependency Explorer) */}
        {onSetFocus && (
          <div className="flex items-center justify-between p-2.5 px-3 rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <Crosshair className={`w-4 h-4 shrink-0 ${isFocusedInGraph ? 'text-brand-500' : 'text-slate-400'}`} />
              <span className="text-slate-700 dark:text-slate-300 font-medium truncate">
                {isFocusedInGraph ? t('inspector.focusedInGraph') : t('inspector.inspectingNode')}
              </span>
            </div>
            {!isFocusedInGraph && (
              <button
                onClick={() => onSetFocus(item)}
                data-testid="inspector-set-focus"
                className="px-2.5 py-1 rounded-md text-xs font-semibold bg-brand-50 text-brand-700 dark:bg-brand-950/80 dark:text-brand-300 border border-brand-200 dark:border-brand-800 hover:bg-brand-100 transition-colors shrink-0"
              >
                {t('inspector.setCenterFocus')}
              </button>
            )}
          </div>
        )}

        {/* Blocked Alert Banner if blocked */}
        {item.isBlocked && (
          <div className="p-3.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="text-xs">
              <span className="font-semibold text-rose-800 dark:text-rose-200 block text-sm mb-0.5">
                {t('inspector.blockedTitle')}
              </span>
              <span className="text-rose-700 dark:text-rose-300 leading-relaxed">
                {t('inspector.blockedDesc')}
              </span>
            </div>
          </div>
        )}

        {/* Title */}
        <div>
          <h3 className="text-base sm:text-lg font-semibold text-slate-900 dark:text-slate-100 leading-snug">
            {item.title}
          </h3>

          <div className="flex items-center gap-2 mt-2 text-xs text-slate-500 dark:text-slate-400">
            <FolderGit2 className="w-3.5 h-3.5 text-slate-400" />
            <span className="font-medium text-slate-700 dark:text-slate-300">{item.project}</span>
            {item.iteration && (
              <>
                <span>•</span>
                <span>{item.iteration}</span>
              </>
            )}
          </div>
        </div>

        {/* Essential Properties (Clean table without nested cards) */}
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800 text-xs">
          <div className="flex items-center justify-between p-2.5 px-3">
            <span className="text-slate-500 dark:text-slate-400 font-medium">{t('fields.state')}</span>
            <span className="font-medium text-slate-800 dark:text-slate-200 px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
              {stateLabel(t, item.state)}
            </span>
          </div>

          <div className="flex items-center justify-between p-2.5 px-3">
            <span className="text-slate-500 dark:text-slate-400 font-medium">{t('fields.priority')}</span>
            <span className={`font-semibold ${
              item.priority === 1
                ? 'text-rose-600 dark:text-rose-400'
                : item.priority === 2
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-slate-700 dark:text-slate-300'
            }`}>
              {item.priority === 1 ? t('priorities.p1') : item.priority === 2 ? t('priorities.p2') : `P${item.priority}`}
            </span>
          </div>

          <div className="flex items-center justify-between p-2.5 px-3">
            <span className="text-slate-500 dark:text-slate-400 font-medium">{t('fields.assignee')}</span>
            {item.isUnassigned ? (
              <span className="text-amber-600 dark:text-amber-400 font-semibold">{t('fields.unassigned')}</span>
            ) : (
              <div className="flex items-center gap-1.5">
                <UserAvatar name={item.assignedTo} avatarUrl={item.assignedAvatar} size="xs" />
                <span className="font-medium text-slate-800 dark:text-slate-200">{item.assignedTo}</span>
              </div>
            )}
          </div>

          {item.storyPoints && (
            <div className="flex items-center justify-between p-2.5 px-3">
              <span className="text-slate-500 dark:text-slate-400 font-medium">{t('fields.storyPoints')}</span>
              <span className="font-mono font-medium text-slate-800 dark:text-slate-200">{t('fields.storyPointsValue', { value: item.storyPoints })}</span>
            </div>
          )}
        </div>

        {/* Description */}
        {item.description && (
          <div className="space-y-1.5">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider block">
              {t('fields.description')}
            </span>
            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
              {item.description}
            </div>
          </div>
        )}

        {/* Parent Hierarchy */}
        <div className="space-y-2">
          <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center justify-between">
            <span>{t('fields.parentHierarchy')}</span>
            <GitBranch className="w-3.5 h-3.5 text-slate-400" />
          </span>

          {parentItem ? (
            <div
              onClick={() => onNavigateToItem(parentItem)}
              className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-brand-500 dark:hover:border-brand-500 bg-white dark:bg-slate-900 cursor-pointer transition-all flex items-center justify-between gap-3 group"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-2 h-2 rounded-full ${getTypeDotColor(parentItem.type)} shrink-0`} />
                <span className="font-mono text-xs font-bold text-slate-500 shrink-0">#{parentItem.id}</span>
                <span className="text-xs font-medium text-slate-800 dark:text-slate-200 group-hover:text-brand-600 truncate">
                  {parentItem.title}
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-brand-500 shrink-0" />
            </div>
          ) : (
            <div className="text-xs text-slate-400 italic p-2 bg-slate-50 dark:bg-slate-900/30 rounded border border-dashed border-slate-200 dark:border-slate-800">
              {t('inspector.topLevel')}
            </div>
          )}
        </div>

        {/* Child Items & Progress */}
        {children.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                {t('inspector.childTasks', { done: completedChildren.length, total: children.length })}
              </span>
              <span className="font-mono text-xs font-bold text-brand-600 dark:text-brand-400">
                {percentComplete}%
              </span>
            </div>

            <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all"
                style={{ width: `${percentComplete}%` }}
              />
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900 text-xs" data-testid="inspector-children">
              {childrenTruncated && (
                <div className="p-2 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30" role="note">
                  {t('inspector.childrenTruncated', { count: children.length })}
                </div>
              )}
              {children.map(child => (
                <div
                  key={child.id}
                  onClick={() => onNavigateToItem(child)}
                  className="p-2.5 flex items-center justify-between gap-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-colors group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-1.5 h-1.5 rounded-full ${getTypeDotColor(child.type)} shrink-0`} />
                    <span className="font-mono text-slate-400 text-xs shrink-0">#{child.id}</span>
                    <span className="text-slate-800 dark:text-slate-200 group-hover:text-brand-600 truncate font-medium">
                      {child.title}
                    </span>
                  </div>
                  <span className="text-xs text-slate-400 shrink-0">{stateLabel(t, child.state)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Predecessors Section */}
        <div className="space-y-2">
          <span className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 text-indigo-700 dark:text-indigo-400">
            <ArrowDownLeft className="w-4 h-4" />
            <span>{t('fields.predecessors')}</span>
            <span className="font-mono text-xs px-1.5 py-0.2 rounded bg-indigo-50 dark:bg-indigo-950 font-bold">
              {item.relations?.predecessors?.length || 0}
            </span>
          </span>

          {item.relations?.predecessors?.length > 0 ? (
            <div className="space-y-2">
              {item.relations.predecessors.map(pred => {
                const isUnknown = !pred.state || pred.state.trim() === '';
                const isDone = !isUnknown && isWorkItemCompleted(pred.state || '', pred.type || '');
                const isResolved = !isUnknown && getWorkItemStateCategory(pred.state || '') === 'Resolved';
                const fullItem = related.get(pred.id);

                return (
                  <div
                    key={pred.id}
                    onClick={() => fullItem && onNavigateToItem(fullItem)}
                    className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-indigo-400 bg-white dark:bg-slate-900 text-xs flex items-center justify-between gap-2 cursor-pointer transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">#{pred.id}</span>
                      <span className="text-slate-800 dark:text-slate-200 group-hover:text-indigo-600 truncate font-medium">
                        {pred.title || t('inspector.unresolvedTitle')}
                      </span>
                    </div>

                    <div className="shrink-0 flex items-center gap-1.5">
                      {isUnknown ? (
                        <span
                          className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1 font-semibold"
                          title={t('inspector.unresolvedTip')}
                          data-testid="inspector-unresolved"
                        >
                          <Clock className="w-3.5 h-3.5" /> {t('inspector.unresolved')}
                        </span>
                      ) : isDone ? (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" /> {t('inspector.done')}
                        </span>
                      ) : isResolved ? (
                        <span className="text-xs text-indigo-600 dark:text-indigo-400 flex items-center gap-1 font-semibold">
                          <Clock className="w-3.5 h-3.5" /> {t('inspector.resolvedInReview')}
                        </span>
                      ) : (
                        <span className="text-xs text-rose-600 dark:text-rose-400 flex items-center gap-1 font-semibold animate-pulse">
                          <Clock className="w-3.5 h-3.5" /> {t('chip.blockingThis')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic p-2 bg-slate-50 dark:bg-slate-900/30 rounded border border-dashed border-slate-200 dark:border-slate-800">
              {t('inspector.noPredecessors')}
            </p>
          )}
        </div>

        {/* Successors Section */}
        <div className="space-y-2">
          <span className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 text-cyan-700 dark:text-cyan-400">
            <ArrowUpRight className="w-4 h-4" />
            <span>{t('fields.successors')}</span>
            <span className="font-mono text-xs px-1.5 py-0.2 rounded bg-cyan-50 dark:bg-cyan-950 font-bold">
              {item.relations?.successors?.length || 0}
            </span>
          </span>

          {item.relations?.successors?.length > 0 ? (
            <div className="space-y-2">
              {item.relations.successors.map(succ => {
                const fullItem = related.get(succ.id);

                return (
                  <div
                    key={succ.id}
                    onClick={() => fullItem && onNavigateToItem(fullItem)}
                    className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-cyan-400 bg-white dark:bg-slate-900 text-xs flex items-center justify-between gap-2 cursor-pointer transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono font-bold text-cyan-600 dark:text-cyan-400">#{succ.id}</span>
                      <span className="text-slate-800 dark:text-slate-200 group-hover:text-cyan-600 truncate font-medium">
                        {succ.title || t('inspector.unresolvedTitle')}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500 font-medium shrink-0">{stateLabel(t, succ.state || '')}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic p-2 bg-slate-50 dark:bg-slate-900/30 rounded border border-dashed border-slate-200 dark:border-slate-800">
              {t('inspector.noSuccessors')}
            </p>
          )}
        </div>
      </div>
    </aside>
  );
};
