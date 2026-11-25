import { useMemo, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { buildMonthGrid, formatDayLabel } from '../../../services/dateRange';
import type { ActivityDay, ActivityMetric } from '../../../services/activityDaily';
import { densityLevel, maxCoveredCount } from './activityModel';

export interface ActivityCalendarProps {
  days: ActivityDay[] | null;
  /** First day of the month on show (`YYYY-MM-01`). */
  viewMonth: string;
  start: string;
  end: string;
  todayKey: string;
  earliestKey: string;
  metric: ActivityMetric;
  locale: string;
  /** The one day that is in the tab order. */
  rovingDate: string;
  onPick: (date: string) => void;
  /** Called for arrow-key moves; the parent changes the month when the target is outside it. */
  onMove: (from: string, delta: number) => void;
  /** Day information for the footer line (the only day readout on touch screens). */
  onInfo: (text: string) => void;
}

interface Tip {
  text: string;
  x: number;
  y: number;
}

function matchesFocusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
}

/** One month grid that doubles as the activity heatmap: density, coverage and stale state live on the day cells. */
export function ActivityCalendar({ days, viewMonth, start, end, todayKey, earliestKey, metric, locale, rovingDate, onPick, onMove, onInfo }: ActivityCalendarProps) {
  const { t } = useTranslation('dateRange');
  const [tip, setTip] = useState<Tip | null>(null);
  const year = Number(viewMonth.slice(0, 4));
  const month = Number(viewMonth.slice(5, 7)) - 1;
  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const byDate = useMemo(() => new Map((days ?? []).map(d => [d.date, d])), [days]);
  const maxCount = useMemo(() => maxCoveredCount((days ?? []).filter(d => d.date.slice(0, 7) === viewMonth.slice(0, 7))), [days, viewMonth]);
  const unit = t(`activity.units.${metric}`);
  const weekdays = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, i) => formatter.format(new Date(Date.UTC(2024, 0, 1 + i))));
  }, [locale]);

  const describe = (date: string, day: ActivityDay | undefined): string => {
    const label = formatDayLabel(date, locale);
    if (!day) return label;
    let text: string;
    switch (day.state) {
      case 'covered_active':
        text = t('activity.day.covered', { date: label, count: day.count ?? 0, unit });
        break;
      case 'covered_zero':
        text = t('activity.day.zero', { date: label });
        break;
      case 'partial':
        text = t('activity.day.partial', { date: label });
        break;
      case 'unavailable_retention':
        text = t('activity.day.unavailable', { date: label });
        break;
      default:
        text = t('activity.day.notCollected', { date: label });
    }
    return day.stale ? `${text}${t('activity.day.stale')}` : text;
  };

  const showTip = (element: HTMLElement, text: string) => {
    const rect = element.getBoundingClientRect();
    setTip({ text, x: rect.left + rect.width / 2, y: rect.top });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = offsets[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    onMove(date, delta);
  };

  return (
    <>
      <div className="drp-grid" aria-hidden="true">
        {weekdays.map(label => <span key={label} className="drp-wd">{label}</span>)}
      </div>
      <div className="drp-grid" role="group" aria-label={t('calendar.label')} data-testid="date-range-days">
        {weeks.flat().map((date, index) => {
          if (!date) return <span key={`pad-${index}`} aria-hidden="true" />;
          const day = byDate.get(date);
          const future = date > todayKey;
          const tooOld = date < earliestKey;
          const disabled = future || tooOld;
          const classes = ['drp-d'];
          let level: number | undefined;
          if (disabled) classes.push('future');
          else if (!day) classes.push('unk');
          else if (day.state === 'covered_zero') classes.push('z');
          else if (day.state === 'covered_active') {
            level = densityLevel(day.count ?? 0, maxCount);
            classes.push(`l${level}`);
          } else if (day.state === 'partial') classes.push('partial');
          else if (day.state === 'unavailable_retention') classes.push('unav');
          else classes.push('ncol');
          if (day?.stale && !disabled) classes.push('stale');
          const inRange = date >= start && date <= end;
          if (inRange) classes.push('inr');
          if (date === start || date === end) classes.push('edge');
          const text = describe(date, disabled ? undefined : day);
          return (
            <button
              key={date}
              type="button"
              className={classes.join(' ')}
              data-date={date}
              data-state={disabled ? undefined : day?.state}
              data-level={level}
              data-stale={day?.stale && !disabled ? 'true' : undefined}
              aria-label={text}
              aria-pressed={inRange}
              aria-disabled={disabled ? 'true' : undefined}
              tabIndex={date === rovingDate ? 0 : -1}
              onPointerEnter={(event: ReactPointerEvent<HTMLButtonElement>) => {
                if (event.pointerType === 'mouse') showTip(event.currentTarget, text);
              }}
              onPointerLeave={() => setTip(null)}
              onFocus={event => {
                if (matchesFocusVisible(event.currentTarget)) showTip(event.currentTarget, text);
              }}
              onBlur={() => setTip(null)}
              onPointerDown={() => onInfo(text)}
              onClick={() => {
                if (disabled) return;
                onInfo(text);
                onPick(date);
              }}
              onKeyDown={event => onKeyDown(event, date)}
            >
              {Number(date.slice(8, 10))}
            </button>
          );
        })}
      </div>
      {tip ? (
        <div role="status" className="drp-tip" data-testid="date-range-tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      ) : null}
    </>
  );
}
