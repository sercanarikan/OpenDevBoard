import { useMemo, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { addDaysToKey, dayCountInclusive, formatDayLabel } from '../../../services/dateRange';
import type { ActivityDay } from '../../../services/activityDaily';
import { bin, dayVisual, maxCoveredCount, stepHandle, timelineGranularity, type HandleKey } from './activityModel';

export interface ActivityTimelineProps {
  days: ActivityDay[];
  draftStart: string;
  draftEnd: string;
  onDraftChange: (start: string, end: string) => void;
  locale: string;
}

type Which = 'start' | 'end';

const HATCH = 'repeating-linear-gradient(135deg, rgb(148 163 184 / 0.6) 0 2px, transparent 2px 6px)';

/**
 * Interactive activity timeline. Dragging and keyboard changes only update the draft range; nothing here starts a
 * request. The parent applies the draft when the user presses Apply.
 */
export function ActivityTimeline({ days, draftStart, draftEnd, onDraftChange, locale }: ActivityTimelineProps) {
  const { t } = useTranslation('dateRange');
  const trackRef = useRef<HTMLDivElement>(null);
  const minKey = days[0]?.date ?? draftStart;
  const maxKey = days[days.length - 1]?.date ?? draftEnd;
  const dayCount = days.length || 1;
  const granularity = timelineGranularity(dayCount);
  const bins = useMemo(() => bin(days, granularity), [days, granularity]);
  const maxCount = useMemo(() => maxCoveredCount(days), [days]);

  const indexOf = (key: string) => Math.max(0, Math.min(dayCount - 1, dayCountInclusive(minKey, key) - 1));
  const startIndex = indexOf(draftStart);
  const endIndex = indexOf(draftEnd);
  const pct = (index: number) => (index / dayCount) * 100;

  const apply = (which: Which, nextKey: string) => {
    if (which === 'start') {
      const start = nextKey > draftEnd ? draftEnd : nextKey;
      onDraftChange(start, draftEnd);
    } else {
      const end = nextKey < draftStart ? draftStart : nextKey;
      onDraftChange(draftStart, end);
    }
  };

  const keyToDate = (which: Which, key: HandleKey, shift: boolean) => {
    const current = which === 'start' ? draftStart : draftEnd;
    return stepHandle(current, key, shift, minKey, maxKey);
  };

  const onHandleKey = (which: Which, event: KeyboardEvent<HTMLDivElement>) => {
    const keys: HandleKey[] = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key as HandleKey)) return;
    event.preventDefault();
    apply(which, keyToDate(which, event.key as HandleKey, event.shiftKey));
  };

  const dateAtPointer = (clientX: number): string => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return minKey;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const index = Math.min(dayCount - 1, Math.floor(fraction * dayCount));
    return addDaysToKey(minKey, index);
  };

  const onPointerDown = (which: Which, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    apply(which, dateAtPointer(event.clientX));
  };

  const onPointerMove = (which: Which, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    apply(which, dateAtPointer(event.clientX));
  };

  const handleLabel = (which: Which) => t(which === 'start' ? 'activity.startHandle' : 'activity.endHandle');

  const handleProps = (which: Which, date: string, index: number) => ({
    role: 'slider' as const,
    tabIndex: 0,
    'aria-label': handleLabel(which),
    'aria-valuemin': 0,
    'aria-valuemax': dayCount - 1,
    'aria-valuenow': index,
    'aria-valuetext': formatDayLabel(date, locale),
    'data-handle': which,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => onHandleKey(which, event),
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => onPointerDown(which, event),
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => onPointerMove(which, event),
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
  });

  const nudge = (which: Which, delta: 1 | -1) => {
    const current = which === 'start' ? draftStart : draftEnd;
    apply(which, addDaysToKey(current, delta));
  };

  return (
    <div className="space-y-2" data-testid="activity-timeline">
      <div
        ref={trackRef}
        role="img"
        aria-label={`${t('activity.timelineLabel')}: ${formatDayLabel(draftStart, locale)} – ${formatDayLabel(draftEnd, locale)}`}
        className="relative h-16 flex items-end gap-px select-none"
      >
        {bins.map(b => {
          const first = b.start;
          const index = indexOf(first);
          const size = b.end === b.start ? 1 : dayCountInclusive(b.start, b.end);
          const visual = dayVisual({ date: b.start, count: b.count, state: b.state, stale: false } as ActivityDay, maxCount);
          const heightPct = b.count && maxCount > 0 ? Math.max(8, (b.count / maxCount) * 100) : b.state === 'covered_zero' ? 4 : 100;
          const inRange = index + size > startIndex && index <= endIndex;
          const style = {
            width: `${(size / dayCount) * 100}%`,
            height: `${heightPct}%`,
            backgroundImage: visual.pattern === 'hatch' ? HATCH : undefined,
          };
          const barClass = [
            'min-w-[2px] rounded-t-sm transition-colors',
            b.state === 'covered_active' ? 'bg-brand-500 dark:bg-brand-400' : '',
            b.state === 'covered_zero' ? 'bg-slate-200 dark:bg-slate-700' : '',
            visual.pattern === 'dashed' ? 'border border-dashed border-slate-400 bg-transparent' : '',
            b.state === 'partial' ? 'bg-slate-300 dark:bg-slate-600' : '',
            inRange ? '' : 'opacity-50',
          ].join(' ');
          return <div key={b.start} className={barClass} style={style} title={`${b.start}${b.end !== b.start ? ` – ${b.end}` : ''}`} />;
        })}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 top-0 border-x-2 border-amber-500 bg-amber-500/10"
          style={{ left: `${pct(startIndex)}%`, width: `${pct(endIndex + 1) - pct(startIndex)}%` }}
        />
        <div
          {...handleProps('start', draftStart, startIndex)}
          className="absolute -top-1 bottom-0 w-3 -ml-1.5 cursor-ew-resize rounded-sm bg-amber-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 touch-none"
          style={{ left: `${pct(startIndex)}%` }}
        />
        <div
          {...handleProps('end', draftEnd, endIndex)}
          className="absolute -top-1 bottom-0 w-3 -ml-1.5 cursor-ew-resize rounded-sm bg-amber-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 touch-none"
          style={{ left: `${pct(endIndex + 1)}%` }}
        />
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="flex items-center justify-between gap-1">
          <button type="button" aria-label={t('activity.nudgeStartEarlier')} onClick={() => nudge('start', -1)} className="min-h-[44px] min-w-[44px] rounded-md border border-slate-300 dark:border-slate-600 px-2 focus-visible:outline-2 focus-visible:outline-brand-500">−</button>
          <span className="truncate text-slate-600 dark:text-slate-300">{handleLabel('start')}: {formatDayLabel(draftStart, locale)}</span>
          <button type="button" aria-label={t('activity.nudgeStartLater')} onClick={() => nudge('start', 1)} className="min-h-[44px] min-w-[44px] rounded-md border border-slate-300 dark:border-slate-600 px-2 focus-visible:outline-2 focus-visible:outline-brand-500">+</button>
        </div>
        <div className="flex items-center justify-between gap-1">
          <button type="button" aria-label={t('activity.nudgeEndEarlier')} onClick={() => nudge('end', -1)} className="min-h-[44px] min-w-[44px] rounded-md border border-slate-300 dark:border-slate-600 px-2 focus-visible:outline-2 focus-visible:outline-brand-500">−</button>
          <span className="truncate text-slate-600 dark:text-slate-300">{handleLabel('end')}: {formatDayLabel(draftEnd, locale)}</span>
          <button type="button" aria-label={t('activity.nudgeEndLater')} onClick={() => nudge('end', 1)} className="min-h-[44px] min-w-[44px] rounded-md border border-slate-300 dark:border-slate-600 px-2 focus-visible:outline-2 focus-visible:outline-brand-500">+</button>
        </div>
      </div>
    </div>
  );
}
