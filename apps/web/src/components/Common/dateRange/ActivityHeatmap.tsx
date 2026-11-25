import { useMemo, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { buildMonthGrid, formatDayLabel } from '../../../services/dateRange';
import type { ActivityDay, ActivityMetric } from '../../../services/activityDaily';
import { dayVisual, maxCoveredCount, type ActivityLevel } from './activityModel';

export interface ActivityHeatmapProps {
  days: ActivityDay[];
  draftStart: string;
  draftEnd: string;
  metric: ActivityMetric;
  locale: string;
  onSelectDay?: (date: string) => void;
}

const LEVEL_CLASS: Record<ActivityLevel, string> = {
  0: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
  1: 'bg-brand-200 dark:bg-brand-900/60 text-slate-800 dark:text-slate-100',
  2: 'bg-brand-400 dark:bg-brand-700 text-slate-900 dark:text-white',
  3: 'bg-brand-600 dark:bg-brand-500 text-white',
  4: 'bg-brand-800 dark:bg-brand-300 text-white dark:text-slate-900',
};

const HATCH_STYLE: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(148 163 184 / 0.55) 0 2px, transparent 2px 6px)',
};

const WEEKDAYS_FROM_MONDAY = [0, 1, 2, 3, 4, 5, 6];

function monthTitle(key: string, locale: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

function weekdayLabel(index: number, locale: string): string {
  // 2024-01-01 was a Monday; use it as a stable anchor for weekday names.
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)));
}

export function ActivityHeatmap({ days, draftStart, draftEnd, metric, locale, onSelectDay }: ActivityHeatmapProps) {
  const { t } = useTranslation('dateRange');
  const byDate = useMemo(() => new Map(days.map(d => [d.date, d])), [days]);
  const maxCount = useMemo(() => maxCoveredCount(days), [days]);
  const months = useMemo(() => {
    const keys: string[] = [];
    for (const day of days) {
      const key = day.date.slice(0, 7);
      if (keys[keys.length - 1] !== key) keys.push(key);
    }
    return keys;
  }, [days]);
  const unit = t(`activity.units.${metric}`);

  const dayText = (day: ActivityDay): string => {
    const date = formatDayLabel(day.date, locale);
    let text: string;
    switch (day.state) {
      case 'covered_active':
        text = t('activity.day.covered', { date, count: day.count ?? 0, unit });
        break;
      case 'covered_zero':
        text = t('activity.day.zero', { date });
        break;
      case 'partial':
        text = t('activity.day.partial', { date });
        break;
      case 'unavailable_retention':
        text = t('activity.day.unavailable', { date });
        break;
      default:
        text = t('activity.day.notCollected', { date });
    }
    return day.stale ? `${text}${t('activity.day.stale')}` : text;
  };

  const focusNeighbour = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = offsets[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const [y, m, d] = date.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
    const target = event.currentTarget.parentElement?.closest('[data-heatmap]')?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`);
    target?.focus();
  };

  return (
    <div data-testid="activity-heatmap" data-heatmap className="space-y-3">
      <div className="max-h-64 overflow-y-auto pr-1 space-y-3">
        {months.map(monthKey => {
          const grid = buildMonthGrid(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1);
          return (
            <section key={monthKey} aria-label={monthTitle(monthKey, locale)}>
              <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">{monthTitle(monthKey, locale)}</h4>
              <div className="grid grid-cols-7 gap-1 text-[10px] text-slate-400 mb-1" aria-hidden="true">
                {WEEKDAYS_FROM_MONDAY.map(i => <span key={i} className="text-center">{weekdayLabel(i, locale)}</span>)}
              </div>
              <div role="group" className="grid grid-cols-7 gap-1">
                {grid.flat().map((date, index) => {
                  if (!date) return <span key={`pad-${monthKey}-${index}`} aria-hidden="true" />;
                  const day = byDate.get(date);
                  if (!day) return <span key={date} aria-hidden="true" />;
                  const visual = dayVisual(day, maxCount);
                  const inRange = date >= draftStart && date <= draftEnd;
                  const edge = date === draftStart || date === draftEnd;
                  const classes = [
                    'relative h-9 min-h-[36px] w-full rounded-md text-[11px] font-medium tabular-nums',
                    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500',
                    visual.pattern === 'dashed' ? 'border border-dashed border-slate-400 dark:border-slate-500 bg-transparent' : LEVEL_CLASS[visual.level],
                    inRange ? 'ring-2 ring-amber-500 ring-offset-1 ring-offset-white dark:ring-offset-slate-900' : '',
                    edge ? 'font-bold' : '',
                  ].join(' ');
                  return (
                    <button
                      key={date}
                      type="button"
                      data-date={date}
                      data-state={day.state}
                      data-stale={day.stale ? 'true' : undefined}
                      aria-label={dayText(day)}
                      aria-pressed={inRange}
                      tabIndex={date === draftStart ? 0 : -1}
                      className={classes}
                      style={visual.pattern === 'hatch' ? HATCH_STYLE : undefined}
                      onClick={() => onSelectDay?.(date)}
                      onKeyDown={event => focusNeighbour(event, date)}
                    >
                      {Number(date.slice(8, 10))}
                      {day.stale ? <span aria-hidden="true" className="absolute top-0.5 right-0.5 h-1 w-1 rounded-full bg-amber-500" /> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
        <li className="flex items-center gap-1.5"><span className={`h-3 w-3 rounded-sm ${LEVEL_CLASS[0]}`} aria-hidden="true" />{t('activity.legend.coveredZero')}</li>
        <li className="flex items-center gap-1.5"><span className={`h-3 w-3 rounded-sm ${LEVEL_CLASS[3]}`} aria-hidden="true" />{t('activity.legend.coveredActive')}</li>
        <li className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm" style={HATCH_STYLE} aria-hidden="true" />{t('activity.legend.partial')}</li>
        <li className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-dashed border-slate-400" aria-hidden="true" />{t('activity.legend.notCollected')}</li>
        <li className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-dashed border-slate-400 bg-slate-50 dark:bg-slate-900" aria-hidden="true" />{t('activity.legend.unavailable')}</li>
        <li className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm ring-2 ring-amber-500" aria-hidden="true" />{t('activity.legend.selected')}</li>
        <li className="flex items-center gap-1.5"><span className="relative h-3 w-3 rounded-sm bg-slate-200 dark:bg-slate-700"><span className="absolute top-0 right-0 h-1 w-1 rounded-full bg-amber-500" aria-hidden="true" /></span>{t('activity.legend.stale')}</li>
      </ul>
    </div>
  );
}
