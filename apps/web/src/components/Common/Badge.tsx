import React from 'react';
import { useTranslation } from 'react-i18next';
import { stateLabel, priorityLabel } from '../../i18n/labels';

interface TypeBadgeProps {
  type: string;
  size?: 'sm' | 'md';
  showIcon?: boolean;
}

export const TypeBadge: React.FC<TypeBadgeProps> = ({ type, size = 'sm' }) => {
  const t = type.toLowerCase();

  let bg = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700';
  let dot = 'bg-slate-500';

  if (t.includes('epic')) {
    bg = 'bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 border-purple-200 dark:border-purple-800/60';
    dot = 'bg-purple-500';
  } else if (t.includes('feature')) {
    bg = 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/60';
    dot = 'bg-indigo-500';
  } else if (t.includes('story') || t.includes('pbi') || t.includes('product backlog')) {
    bg = 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300 border-sky-200 dark:border-sky-800/60';
    dot = 'bg-sky-500';
  } else if (t.includes('bug')) {
    bg = 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border-rose-200 dark:border-rose-800/60';
    dot = 'bg-rose-500';
  } else if (t.includes('task')) {
    bg = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/60';
    dot = 'bg-emerald-500';
  }

  const px = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span className={`inline-flex items-center gap-1.5 font-medium rounded-md border ${bg} ${px} tracking-tight select-none whitespace-nowrap shrink-0`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span>{type}</span>
    </span>
  );
};

interface StateBadgeProps {
  state: string;
  size?: 'sm' | 'md';
}

export const StateBadge: React.FC<StateBadgeProps> = ({ state, size = 'sm' }) => {
  const { t } = useTranslation();
  const s = state.toLowerCase();

  let style = 'bg-slate-100 text-slate-700 dark:bg-slate-800/80 dark:text-slate-300 border-slate-200 dark:border-slate-700';

  if (s.includes('new') || s.includes('to do') || s.includes('proposed')) {
    style = 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 border-blue-200 dark:border-blue-800/50';
  } else if (s.includes('active') || s.includes('in progress') || s.includes('committed')) {
    style = 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border-amber-200 dark:border-amber-800/50';
  } else if (s.includes('resolved') || s.includes('testing')) {
    style = 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300 border-violet-200 dark:border-violet-800/50';
  } else if (s.includes('closed') || s.includes('done') || s.includes('completed')) {
    style = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/50';
  } else if (s.includes('removed')) {
    style = 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 border-gray-200 dark:border-gray-700 line-through';
  }

  const px = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span className={`inline-flex items-center font-medium rounded-full border ${style} ${px} select-none whitespace-nowrap shrink-0`}>
      {stateLabel(t, state)}
    </span>
  );
};

interface PriorityBadgeProps {
  priority: number;
}

export const PriorityBadge: React.FC<PriorityBadgeProps> = ({ priority }) => {
  const { t } = useTranslation();
  let label = 'Low';
  let style = 'text-slate-500 bg-slate-100 dark:bg-slate-800/80 dark:text-slate-400 border-slate-200 dark:border-slate-700';

  if (priority === 1) {
    label = priorityLabel(t, 1);
    style = 'text-rose-600 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-400 border-rose-200 dark:border-rose-800/60 font-semibold';
  } else if (priority === 2) {
    label = priorityLabel(t, 2);
    style = 'text-amber-600 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-400 border-amber-200 dark:border-amber-800/60 font-medium';
  } else if (priority === 3) {
    label = priorityLabel(t, 3);
    style = 'text-sky-600 bg-sky-50 dark:bg-sky-950/40 dark:text-sky-400 border-sky-200 dark:border-sky-800/60';
  } else if (priority === 4) {
    label = priorityLabel(t, 4);
    style = 'text-slate-500 bg-slate-100 dark:bg-slate-800/80 dark:text-slate-400 border-slate-200 dark:border-slate-700';
  }

  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono rounded border ${style} select-none whitespace-nowrap shrink-0`}>
      {label}
    </span>
  );
};
