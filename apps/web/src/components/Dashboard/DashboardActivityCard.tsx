import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useDateRange } from '../../context/useDateRange';
import { ActivityHeatmap } from '../Common/dateRange/ActivityHeatmap';
import { useActivityDaily } from '../Common/dateRange/useActivityDaily';
import { ACTIVITY_METRICS, type ActivityMetric } from '../../services/activityDaily';

/**
 * Period activity card: a metric chooser and the coverage-backed heatmap for the global date range (header). It is independent of
 * the page's status cards, which keep their live behaviour. Applying a range starts (or reuses) the chunked backend
 * fetch; opening the picker and dragging the timeline do not.
 */
export function DashboardActivityCard() {
  const { t, i18n } = useTranslation('dashboard');
  const locale = i18n.language || 'en';
  const [metric, setMetric] = useState<ActivityMetric>('pipelines');
  const { bounds } = useDateRange();
  const cardRef = useRef<HTMLElement>(null);
  // The card is secondary to the status feeds, so its first request waits until the card is actually on screen.
  const visible = useVisibility(cardRef);
  const { data, error, loading } = useActivityDaily({
    metric,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    mode: 'refresh',
    enabled: visible,
  });

  return (
    <section ref={cardRef} data-testid="dash-activity-card" className="bg-white dark:bg-[#0E131F] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-2xs">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">{t('activityCard.title')}</h2>
          <p className="text-[11px] text-slate-400">{t('activityCard.subtitle')}</p>
          <span data-testid="dash-activity-scope" className="mt-1 inline-block rounded-full bg-brand-50 dark:bg-brand-900/40 px-2 py-0.5 text-[10px] font-semibold text-brand-700 dark:text-brand-300">
            {t('activityCard.periodBadge')}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <span>{t('activity.metricLabel', { ns: 'dateRange' })}</span>
            <select
              data-testid="dash-activity-metric"
              value={metric}
              onChange={event => setMetric(event.target.value as ActivityMetric)}
              className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
            >
              {ACTIVITY_METRICS.map(item => (
                <option key={item} value={item}>{t(`activity.metrics.${item}`, { ns: 'dateRange' })}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {loading && !data ? <p role="status" className="text-xs text-slate-500">{t('activity.loading', { ns: 'dateRange' })}</p> : null}
      {error ? <p role="alert" className="text-xs text-red-600 dark:text-red-400">{t(error === 'timeout' ? 'activity.timeout' : 'activity.loadFailed', { ns: 'dateRange' })}</p> : null}
      {data?.job.state === 'running' ? <p role="status" className="text-xs text-slate-500">{t('activity.job.running', { ns: 'dateRange', total: data.job.pending })}</p> : null}
      {data?.job.state === 'partial' ? <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{t('activity.job.partial', { ns: 'dateRange' })}</p> : null}
      {data?.job.state === 'failed' ? <p role="status" className="text-xs text-red-600 dark:text-red-400">{t('activity.job.failed', { ns: 'dateRange' })}</p> : null}
      {data?.fixture ? <p className="text-[11px] text-amber-700 dark:text-amber-400">{t('activity.fixture', { ns: 'dateRange' })}</p> : null}

      {data ? (
        <>
          <p className="text-[11px] text-slate-500 dark:text-slate-400" data-testid="dash-activity-coverage">
            {t('activityCard.coverage', { partial: data.cacheStatus.partialDays, notCollected: data.cacheStatus.notCollectedDays })}
          </p>
          <ActivityHeatmap days={data.days} draftStart={bounds.startDate} draftEnd={bounds.endDate} metric={metric} locale={locale} />
        </>
      ) : null}
    </section>
  );
}

/** True once the element has intersected the viewport. Without IntersectionObserver the element counts as visible. */
function useVisibility(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}
