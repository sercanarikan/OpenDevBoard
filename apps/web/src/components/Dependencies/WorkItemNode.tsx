import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position } from '@xyflow/react';
import { stateLabel } from '../../i18n/labels';
import { AlertTriangle, ArrowRight, FolderGit2, Crosshair } from 'lucide-react';
import type { DependencyGraphNodeData } from '../../utils/dependencyEngine';

const WorkItemNodeComponent: React.FC<any> = ({ data, selected }) => {
  const { t: tr } = useTranslation(['dependencies', 'common']);
  const nodeData = data as DependencyGraphNodeData;
  const { item, isFocused, blockedEvaluation, onSetFocus } = nodeData;
  const isUnresolved = !!nodeData.isUnresolved;

  const getTypeDotColor = (type: string) => {
    const t = (type || '').toLowerCase();
    if (t.includes('bug')) return 'bg-rose-500';
    if (t.includes('epic')) return 'bg-purple-500';
    if (t.includes('feature')) return 'bg-indigo-500';
    if (t.includes('story') || t.includes('pbi')) return 'bg-sky-500';
    return 'bg-emerald-500';
  };

  const isBlocked = blockedEvaluation.isBlocked;
  const isBlocking = blockedEvaluation.isBlocking;

  return (
    <div
      data-testid="graph-node"
      data-id={item.id}
      data-focused={isFocused ? 'true' : 'false'}
      data-unresolved={isUnresolved ? 'true' : 'false'}
      className={`w-72 rounded-xl p-3.5 select-none text-left transition-all duration-150 cursor-pointer shadow-xs ${
        isUnresolved
          ? 'bg-slate-50 dark:bg-[#0F1522] border border-dashed border-slate-400 dark:border-slate-600'
          : isFocused
          ? 'bg-white dark:bg-[#151D2E] border-2 border-brand-500 ring-4 ring-brand-500/20 shadow-md'
          : selected
          ? 'bg-white dark:bg-[#121929] border-2 border-slate-600 dark:border-slate-300 ring-2 ring-slate-400/20 shadow-sm'
          : isBlocked
          ? 'bg-white dark:bg-[#121929] border border-rose-300 dark:border-rose-900/80 hover:border-rose-400'
          : isBlocking
          ? 'bg-white dark:bg-[#121929] border border-amber-300 dark:border-amber-900/80 hover:border-amber-400'
          : 'bg-white dark:bg-[#121929] border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
      }`}
    >
      {/* Input Target Handle (Predecessors connect on the LEFT) */}
      <Handle
        type="target"
        position={Position.Left}
        className="w-2.5 h-2.5 !bg-indigo-500 !border-2 !border-white dark:!border-slate-900"
      />

      {/* Top Header: ID, Type Dot, State, Focus/Inspect badge */}
      <div className="flex items-center justify-between gap-1.5 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`w-2 h-2 rounded-full ${getTypeDotColor(item.type)} shrink-0`} />
          <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400 shrink-0">
            #{item.id}
          </span>
          <span className="text-[10px] text-slate-400 truncate">
            {item.type}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isFocused ? (
            <span className="text-[10px] font-bold text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-950/80 px-1.5 py-0.2 rounded border border-brand-200 dark:border-brand-800">
              {tr('focus.centerFocus')}
            </span>
          ) : selected ? (
            <span className="text-[10px] font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.2 rounded">
              {tr('node.selected')}
            </span>
          ) : null}

          <span
            className={`text-[10px] font-medium px-1.5 py-0.2 rounded-full ${
              isUnresolved
                ? 'text-slate-500 dark:text-slate-400 bg-slate-200/70 dark:bg-slate-800 border border-dashed border-slate-400'
                : 'text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800'
            }`}
          >
            {isUnresolved ? tr('node.unresolved') : stateLabel(tr, item.state)}
          </span>

          {/* Quick Focus Button if not currently focused */}
          {!isFocused && typeof onSetFocus === 'function' ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                (onSetFocus as (id: number) => void)(item.id);
              }}
              title={tr('node.focusTitle')}
              className="p-1 rounded text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <Crosshair className="w-3 h-3" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Main Task Title (Legible 13px font) */}
      <h4
        title={isUnresolved ? tr('node.unresolvedTip') : item.title}
        className={`text-[13px] font-semibold leading-snug line-clamp-2 mb-2.5 ${
          isFocused ? 'text-brand-600 dark:text-brand-400 font-bold' : 'text-slate-900 dark:text-slate-100'
        }`}
      >
        {isUnresolved ? tr('node.unresolvedTitle') : item.title}
      </h4>

      {/* Footer: Blocked/Blocking indicators & Assignee */}
      <div className="flex items-center justify-between text-[10px] pt-1.5 border-t border-slate-100 dark:border-slate-800/80">
        <div className="flex items-center gap-1">
          {isBlocked && (
            <span
              title={tr('node.blockedTip')}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded font-bold bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-200 dark:border-rose-900"
            >
              <AlertTriangle className="w-2.5 h-2.5 text-rose-500 animate-pulse" />
              {tr('overview.blocked')}
            </span>
          )}
          {isBlocking && (
            <span
              title={tr('node.blockingTip')}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded font-semibold bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-200 dark:border-amber-900"
            >
              <ArrowRight className="w-2.5 h-2.5 text-amber-500" />
              {tr('overview.blocking')}
            </span>
          )}
          {blockedEvaluation.hasUnresolvedPredecessors && !isUnresolved && (
            <span
              title={tr('node.unresolvedPredecessorTip')}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded font-semibold bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 border border-dashed border-slate-400"
            >
              {tr('node.unresolvedPredecessor')}
            </span>
          )}
          {!isBlocked && !isBlocking && !isUnresolved && (
            <span className="text-slate-400 flex items-center gap-1">
              <FolderGit2 className="w-2.5 h-2.5 text-slate-400" />
              <span className="truncate max-w-[85px]">{item.project}</span>
            </span>
          )}
        </div>

        {/* Priority & Assignee */}
        <div className="flex items-center gap-1.5 text-right truncate">
          {item.priority === 1 && (
            <span className="text-[10px] font-bold text-rose-600 dark:text-rose-400">P1</span>
          )}
          {isUnresolved ? null : item.isUnassigned ? (
            <span className="text-amber-600 dark:text-amber-400 font-medium truncate max-w-[80px]">{tr('fields.unassigned', { ns: 'common' })}</span>
          ) : (
            <span className="text-slate-600 dark:text-slate-400 truncate max-w-[80px]">{item.assignedTo}</span>
          )}
        </div>
      </div>

      {/* Output Source Handle (Successors leave on the RIGHT) */}
      <Handle
        type="source"
        position={Position.Right}
        className="w-2.5 h-2.5 !bg-cyan-500 !border-2 !border-white dark:!border-slate-900"
      />
    </div>
  );
};

export const WorkItemNode = memo(WorkItemNodeComponent);
