import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { RichText } from './RichText';

export type DescriptionStatus = 'available' | 'empty' | 'unavailable';

export interface DescriptionBlock {
  /** Optional sub-heading, e.g. "Repro steps" for Bugs. */
  label?: string;
  text: string;
}

interface DescriptionViewProps {
  loading?: boolean;
  /** The detail request itself failed. */
  failed?: boolean;
  /** Server verdict on the description: text exists, confirmed empty, or could not be read. */
  status?: DescriptionStatus;
  blocks: DescriptionBlock[];
  onRetry?: () => void;
  /** Collapse very long text behind an explicit "show full description" control. */
  collapsible?: boolean;
  className?: string;
}

const COLLAPSE_AT = 1500;

/**
 * One place that tells the four description situations apart: loading, could not be loaded, confirmed empty and
 * text. A load failure is never presented as "no description".
 */
export const DescriptionView: React.FC<DescriptionViewProps> = ({
  loading, failed, status, blocks, onRetry, collapsible = true, className = ''
}) => {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const visible = blocks.filter(b => b.text.trim());
  const total = visible.reduce((n, b) => n + b.text.length, 0);
  const collapsed = collapsible && !expanded && total > COLLAPSE_AT;
  const box = `p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 text-slate-700 dark:text-slate-300 text-[12px] leading-relaxed ${className}`;

  if (loading) {
    return <div data-testid="description-loading" role="status" className={`${box} italic text-slate-400`}>{t('descriptionView.loading')}</div>;
  }

  const problem = failed || status === 'unavailable';
  return (
    <div data-testid="description" data-state={problem ? 'error' : visible.length ? 'text' : 'empty'} className="space-y-2">
      {problem && (
        <div role="alert" data-testid="description-error" className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{visible.length ? t('descriptionView.partial') : t('descriptionView.error')}</span>
          {onRetry && (
            <button type="button" onClick={onRetry} data-testid="description-retry" className="font-semibold underline cursor-pointer">
              {t('descriptionView.retry')}
            </button>
          )}
        </div>
      )}
      {visible.length === 0 && !problem && (
        <div data-testid="description-empty" className={`${box} italic text-slate-500 dark:text-slate-400`}>{t('descriptionView.empty')}</div>
      )}
      {visible.length > 0 && (
        <div className={`${box} ${collapsed ? 'max-h-60 overflow-hidden relative' : ''}`}>
          {visible.map((b, i) => (
            <div key={i} className={i > 0 ? 'mt-3' : ''}>
              {b.label && <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">{b.label}</div>}
              <RichText text={b.text} />
            </div>
          ))}
          {collapsed && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-slate-50 dark:from-slate-900 to-transparent" />}
        </div>
      )}
      {visible.length > 0 && total > COLLAPSE_AT && collapsible && (
        <button type="button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded} data-testid="description-toggle"
          className="text-xs font-semibold text-brand-600 dark:text-brand-400 hover:underline cursor-pointer">
          {expanded ? t('descriptionView.showLess') : t('descriptionView.showAll')}
        </button>
      )}
    </div>
  );
};
