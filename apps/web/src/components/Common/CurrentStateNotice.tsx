import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';

/**
 * Shown on screens whose data is current state (never a period). The global date range does not change them.
 */
export function CurrentStateNotice() {
  const { t } = useTranslation('dateRange');
  return (
    <div role="note" data-testid="current-state-notice" className="mx-4 mt-3 sm:mx-6 flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-[#0E131F] dark:text-slate-300 shrink-0">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
      <span>{t('currentStateNotice')}</span>
    </div>
  );
}
