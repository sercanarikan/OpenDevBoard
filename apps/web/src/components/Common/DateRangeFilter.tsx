import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Check } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  DATE_RANGE_MAX_AGE_DAYS,
  DATE_RANGE_MAX_SPAN_DAYS,
  addDaysToKey,
  buildMonthGrid,
  customSelection,
  formatDayLabel,
  isPickableDay,
  periodSelection,
  presetSelection,
  selectionDayCount,
  selectionSpanDays,
  utcTodayKey,
  validateCustomRange,
  type CalendarPresetId,
  type CustomRangeError,
  type DateRangePresetId,
  type DateRangeSelection,
  type PeriodKind,
  type RollingPresetId
} from '../../services/dateRange';
import type { ActivityMetric } from '../../services/activityDaily';
import { ActivityHeatmap } from './dateRange/ActivityHeatmap';
import { ActivityTimeline } from './dateRange/ActivityTimeline';
import { useActivityDaily } from './dateRange/useActivityDaily';

export interface DateRangeFilterProps {
  value: DateRangeSelection;
  onApply: (selection: DateRangeSelection) => void;
  disabled?: boolean;
  /** When set, the panel shows the activity timeline and heatmap for this metric. */
  activityMetric?: ActivityMetric;
  /**
   * Longest selectable span for this screen. Screens whose list endpoints still load upstream in one request keep
   * the 90-day limit; the activity views and the dashboard accept the full query window.
   */
  maxSpanDays?: number;
}

type Tab = 'day' | 'month' | 'quarter' | 'year' | 'custom';
const TABS: Tab[] = ['day', 'month', 'quarter', 'year', 'custom'];
const ROLLING_ORDER: RollingPresetId[] = ['last7', 'last14', 'last30', 'last90'];
const CALENDAR_ORDER: CalendarPresetId[] = ['last1', 'last6m', 'last1y', 'today', 'yesterday', 'thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'thisYear', 'lastYear'];
const CATALOG_DAYS = 365;

const monthStart = (key: string) => `${key.slice(0, 8)}01`;
const monthIndex = (key: string) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) - 1 });
const yearOf = (key: string) => Number(key.slice(0, 4));
const quarterOf = (key: string) => Math.floor((Number(key.slice(5, 7)) - 1) / 3) + 1;

function tabForPreset(preset: CalendarPresetId | RollingPresetId): Tab | null {
  if (preset === 'day' || preset === 'month' || preset === 'quarter' || preset === 'year' || preset === 'custom') return preset;
  return null;
}

function errorKey(error: CustomRangeError): string {
  return `errors.${error}`;
}

function placementFor(trigger: HTMLElement | null) {
  if (!trigger) return null;
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  if (vw < 640) return { mode: 'sheet' as const };
  const gap = 8;
  const width = Math.min(vw - 32, 560);
  const left = Math.min(Math.max(16, rect.left), vw - width - 16);
  const spaceBelow = vh - rect.bottom - 16 - gap;
  const spaceAbove = rect.top - 16 - gap;
  const placeBelow = spaceBelow >= 320 || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(240, placeBelow ? spaceBelow : spaceAbove);
  return placeBelow
    ? { mode: 'popover' as const, left, width, top: rect.bottom + gap, maxHeight }
    : { mode: 'popover' as const, left, width, bottom: vh - rect.top + gap, maxHeight };
}

type Placement = NonNullable<ReturnType<typeof placementFor>>;

/** Timeline and heatmap for the draft range. Rendered only while the panel is open, so its hooks run in-app only. */
function ActivitySection({
  metric,
  draftStart,
  draftEnd,
  todayKey,
  locale,
  onDraftChange,
}: {
  metric: ActivityMetric;
  draftStart: string;
  draftEnd: string;
  todayKey: string;
  locale: string;
  onDraftChange: (start: string, end: string) => void;
}) {
  const { t } = useTranslation('dateRange');
  const catalogStart = draftStart < addDaysToKey(todayKey, -CATALOG_DAYS) ? draftStart : addDaysToKey(todayKey, -CATALOG_DAYS);
  const { data, error, loading } = useActivityDaily({ metric, startDate: catalogStart, endDate: todayKey, mode: 'cache', enabled: true });
  const job = data?.job;
  return (
    <div className="space-y-3" data-testid="date-range-activity">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">{t('activity.title')}</h3>
        {data?.fixture ? <span className="text-[11px] text-amber-700 dark:text-amber-400">{t('activity.fixture')}</span> : null}
      </div>
      {loading && !data ? <p role="status" className="text-xs text-slate-500">{t('activity.loading')}</p> : null}
      {error ? <p role="alert" className="text-xs text-red-600 dark:text-red-400">{t(error === 'timeout' ? 'activity.timeout' : 'activity.loadFailed')}</p> : null}
      {job?.state === 'running' ? <p role="status" className="text-xs text-slate-500">{t('activity.job.running', { total: job.pending })}</p> : null}
      {job?.state === 'partial' ? <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{t('activity.job.partial')}</p> : null}
      {job?.state === 'failed' ? <p role="status" className="text-xs text-red-600 dark:text-red-400">{t('activity.job.failed')}</p> : null}
      {data ? (
        <>
          <ActivityTimeline days={data.days} draftStart={draftStart} draftEnd={draftEnd} onDraftChange={onDraftChange} locale={locale} />
          <ActivityHeatmap days={data.days} draftStart={draftStart} draftEnd={draftEnd} metric={metric} locale={locale} onSelectDay={day => onDraftChange(day, day)} />
        </>
      ) : null}
    </div>
  );
}

export function DateRangeFilter({ value, onApply, disabled = false, activityMetric, maxSpanDays = DATE_RANGE_MAX_SPAN_DAYS }: DateRangeFilterProps) {
  const { t, i18n } = useTranslation('dateRange');
  const locale = i18n.language || 'en';
  const panelId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [todayKey, setTodayKey] = useState(() => utcTodayKey());
  const [tab, setTab] = useState<Tab>('custom');
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const [draftEnd, setDraftEnd] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [viewMonth, setViewMonth] = useState(() => monthStart(utcTodayKey()));
  const [viewYear, setViewYear] = useState(() => yearOf(utcTodayKey()));
  const [placement, setPlacement] = useState<Placement>({ mode: 'sheet' });

  const updatePlacement = () => {
    const next = placementFor(triggerRef.current);
    if (next) setPlacement(next);
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
    // updatePlacement reads refs only and is recreated per open cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[data-preset][aria-checked="true"], [data-preset]')?.focus();
  }, [open]);

  const triggerLabel = useMemo(() => t(`presets.${value.preset}`), [value.preset, t]);
  const rangeText = useMemo(() => {
    if (value.kind === 'rolling') return null;
    if (value.startDate === value.endDate) return formatDayLabel(value.startDate, locale);
    return `${formatDayLabel(value.startDate, locale)} – ${formatDayLabel(value.endDate, locale)}`;
  }, [value, locale]);

  const closePanel = (restoreFocus: boolean) => {
    setOpen(false);
    setAnchor(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const openPanel = () => {
    const today = utcTodayKey();
    setTodayKey(today);
    const activeTab = tabForPreset(value.preset);
    setTab(activeTab ?? 'custom');
    if (value.kind === 'calendar') {
      setDraftStart(value.startDate);
      setDraftEnd(value.endDate);
      setViewMonth(monthStart(value.startDate));
      setViewYear(yearOf(value.startDate));
    } else {
      setDraftStart(null);
      setDraftEnd(null);
      setViewMonth(monthStart(today));
      setViewYear(yearOf(today));
    }
    setAnchor(null);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closePanel(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
    // closePanel is stable for the lifetime of an open panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choosePreset = (preset: DateRangePresetId) => {
    const selection = presetSelection(preset, utcTodayKey());
    if (selectionSpanDays(selection) > maxSpanDays) return;
    onApply(selection);
    closePanel(true);
  };
  const presetTooLong = (preset: DateRangePresetId) => selectionSpanDays(presetSelection(preset, todayKey)) > maxSpanDays;

  const onPresetKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[data-preset]') ?? []);
    const index = items.indexOf(event.currentTarget);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  };

  // A period that is still in progress (current month, quarter or year) is drafted up to today, never into the future.
  const setPeriodDraft = (kind: PeriodKind, params: { date?: string; year?: number; month?: number; quarter?: number }) => {
    const selection = periodSelection(kind, params, todayKey);
    if (selection.kind !== 'calendar') return;
    setDraftStart(selection.startDate);
    setDraftEnd(selection.endDate > todayKey && selection.startDate <= todayKey ? todayKey : selection.endDate);
    setAnchor(null);
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next);
  };

  const onDayPick = (day: string) => {
    if (!isPickableDay(day, todayKey, anchor, maxSpanDays)) return;
    if (anchor === null) {
      setAnchor(day);
      setDraftStart(day);
      setDraftEnd(null);
      return;
    }
    const [start, end] = day < anchor ? [day, anchor] : [anchor, day];
    setDraftStart(start);
    setDraftEnd(end);
    setAnchor(null);
  };

  const dayTabPick = (day: string) => {
    if (!isPickableDay(day, todayKey, null, maxSpanDays)) return;
    setPeriodDraft('day', { date: day });
  };

  const draftReady = Boolean(draftStart && draftEnd && !anchor);
  const customError: CustomRangeError | null = draftReady && draftStart && draftEnd ? validateCustomRange(draftStart, draftEnd, todayKey, maxSpanDays) : null;
  const canApply = draftReady && !customError;

  const applyDraft = () => {
    if (!canApply || !draftStart || !draftEnd) return;
    const full = periodFor(tab, draftStart);
    // A clipped in-progress period (e.g. this year so far) is applied as the explicit range that is shown.
    if (full && full.kind === 'calendar' && full.startDate === draftStart && full.endDate === draftEnd) onApply(full);
    else onApply(customSelection(draftStart, draftEnd));
    closePanel(true);
  };

  const periodFor = (activeTab: Tab, start: string): DateRangeSelection | null => {
    if (activeTab === 'day') return periodSelection('day', { date: start }, todayKey);
    if (activeTab === 'month') return periodSelection('month', { year: yearOf(start), month: Number(start.slice(5, 7)) }, todayKey);
    if (activeTab === 'quarter') return periodSelection('quarter', { year: yearOf(start), quarter: quarterOf(start) }, todayKey);
    if (activeTab === 'year') return periodSelection('year', { year: yearOf(start) }, todayKey);
    return null;
  };

  const { year, month } = monthIndex(viewMonth);
  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, i) => formatter.format(new Date(Date.UTC(2024, 0, 1 + i))));
  }, [locale]);
  const monthTitle = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month, 1))),
    [locale, year, month]
  );
  const earliestMonth = monthStart(addDaysToKey(todayKey, -DATE_RANGE_MAX_AGE_DAYS));
  const canGoPrev = viewMonth > earliestMonth;
  const canGoNext = viewMonth < monthStart(todayKey);
  const moveMonth = (delta: number) => setViewMonth(new Date(Date.UTC(year, month + delta, 1)).toISOString().slice(0, 10));

  const inDraft = (day: string) => Boolean(draftStart && draftEnd && day >= draftStart && day <= draftEnd);
  const isDraftEdge = (day: string) => day === draftStart || day === draftEnd;
  const dayClick = tab === 'day' ? dayTabPick : onDayPick;

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, day: string) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, PageUp: -30, PageDown: 30 };
    const delta = offsets[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const target = addDaysToKey(day, delta);
    if (!isPickableDay(target, todayKey, anchor, maxSpanDays)) return;
    setViewMonth(monthStart(target));
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>(`[data-day="${target}"]`)?.focus());
  };

  const spanText = draftStart && draftEnd ? t('summary.spanDays', { count: selectionDayCount(customSelection(draftStart, draftEnd)) }) : t('summary.pickStart');
  const selectedTab: Tab | null = tab;
  const presetActive = (preset: DateRangePresetId) => value.preset === preset;

  const panel = (
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="date-range-panel"
      className={
        placement.mode === 'sheet'
          ? 'fixed inset-x-0 bottom-0 z-[60] max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))]'
          : 'fixed z-[60] overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-4'
      }
      style={placement.mode === 'popover' ? { left: placement.left, width: placement.width, top: placement.top, bottom: placement.bottom, maxHeight: placement.maxHeight } : undefined}
    >
      <h2 id={titleId} className="sr-only">{t('title')}</h2>

      {/* pb keeps the last legend row above the sticky action bar on phones */}
      <div className="grid gap-4 pb-20 sm:grid-cols-[minmax(0,160px)_minmax(0,1fr)] sm:pb-0">
        <div className="space-y-3">
          <div role="group" aria-label={t('groups.rolling')} className="flex flex-wrap gap-1.5">
            {ROLLING_ORDER.map(preset => (
              <button key={preset} type="button" data-preset={preset} aria-checked={presetActive(preset)} disabled={presetTooLong(preset)} onKeyDown={onPresetKeyDown} onClick={() => choosePreset(preset)}
                className={`min-h-[36px] px-2.5 rounded-md text-xs border ${presetActive(preset) ? 'border-brand-500 bg-brand-600 text-white' : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-brand-500'} disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-brand-500`}>
                {t(`presets.${preset}`)}
              </button>
            ))}
          </div>
          {maxSpanDays < DATE_RANGE_MAX_SPAN_DAYS ? <p className="text-[11px] text-slate-500 dark:text-slate-400">{t('limitHint', { max: maxSpanDays })}</p> : null}
          <div role="group" aria-label={t('groups.calendar')} className="flex flex-wrap gap-1.5">
            {CALENDAR_ORDER.map(preset => (
              <button key={preset} type="button" data-preset={preset} aria-checked={presetActive(preset)} disabled={presetTooLong(preset)} onKeyDown={onPresetKeyDown} onClick={() => choosePreset(preset)}
                className={`min-h-[36px] px-2.5 rounded-md text-xs border ${presetActive(preset) ? 'border-brand-500 bg-brand-600 text-white' : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-brand-500'} disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-brand-500`}>
                {t(`presets.${preset}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3 min-w-0">
          <div role="tablist" aria-label={t('groups.period')} onKeyDown={onTabKeyDown} className="flex flex-wrap gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
            {TABS.map(item => (
              <button key={item} type="button" role="tab" aria-selected={selectedTab === item} tabIndex={selectedTab === item ? 0 : -1} onClick={() => setTab(item)}
                className={`flex-1 min-h-[36px] px-2 rounded-md text-xs font-semibold ${selectedTab === item ? 'bg-white dark:bg-slate-900 text-brand-700 dark:text-brand-300 shadow-sm' : 'text-slate-600 dark:text-slate-300'} focus-visible:outline-2 focus-visible:outline-brand-500`}>
                {t(`periods.${item}`)}
              </button>
            ))}
          </div>

          {tab === 'year' || tab === 'quarter' || tab === 'month' ? (
            <div className="space-y-2" data-testid="date-range-period">
              <div className="flex items-center justify-between">
                <button type="button" aria-label={t('period.previousYear')} onClick={() => setViewYear(viewYear - 1)} className="min-h-[36px] min-w-[36px] rounded-md border border-slate-200 dark:border-slate-700">‹</button>
                <span className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">{viewYear}</span>
                <button type="button" aria-label={t('period.nextYear')} disabled={viewYear >= yearOf(todayKey)} onClick={() => setViewYear(viewYear + 1)} className="min-h-[36px] min-w-[36px] rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-40">›</button>
              </div>
              {tab === 'month' ? (
                <div className="grid grid-cols-3 gap-1.5">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                    const candidate = `${viewYear}-${String(m).padStart(2, '0')}-01`;
                    const disabledMonth = candidate > todayKey;
                    const selected = draftStart?.slice(0, 7) === candidate.slice(0, 7);
                    return (
                      <button key={m} type="button" disabled={disabledMonth} aria-pressed={selected} onClick={() => setPeriodDraft('month', { year: viewYear, month: m })}
                        className={`min-h-[36px] rounded-md text-xs border ${selected ? 'border-brand-500 bg-brand-600 text-white' : 'border-slate-200 dark:border-slate-700'} disabled:opacity-40`}>
                        {new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(viewYear, m - 1, 1)))}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {tab === 'quarter' ? (
                <div className="grid grid-cols-4 gap-1.5">
                  {[1, 2, 3, 4].map(q => {
                    const start = `${viewYear}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
                    const selected = draftStart === start;
                    return (
                      <button key={q} type="button" disabled={start > todayKey} aria-pressed={selected} onClick={() => setPeriodDraft('quarter', { year: viewYear, quarter: q })}
                        className={`min-h-[36px] rounded-md text-xs border ${selected ? 'border-brand-500 bg-brand-600 text-white' : 'border-slate-200 dark:border-slate-700'} disabled:opacity-40`}>
                        {t('period.quarterLabel', { quarter: q })}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {tab === 'year' ? (
                <div className="grid grid-cols-3 gap-1.5">
                  <button type="button" aria-pressed={draftStart === `${viewYear}-01-01` && draftEnd === `${viewYear}-12-31`} onClick={() => setPeriodDraft('year', { year: viewYear })}
                    className="col-span-3 min-h-[36px] rounded-md text-xs border border-slate-200 dark:border-slate-700">
                    {viewYear}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === 'day' || tab === 'custom' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <button type="button" aria-label={t('calendar.previousMonth')} disabled={!canGoPrev} onClick={() => moveMonth(-1)} className="min-h-[36px] min-w-[36px] rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-40">‹</button>
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 capitalize">{monthTitle}</span>
                <button type="button" aria-label={t('calendar.nextMonth')} disabled={!canGoNext} onClick={() => moveMonth(1)} className="min-h-[36px] min-w-[36px] rounded-md border border-slate-200 dark:border-slate-700 disabled:opacity-40">›</button>
              </div>
              <div className="grid grid-cols-7 gap-1 text-[10px] text-slate-500" aria-hidden="true">
                {weekdayLabels.map(label => <span key={label} className="text-center">{label}</span>)}
              </div>
              <div role="group" aria-label={monthTitle} className="grid grid-cols-7 gap-1">
                {weeks.flat().map((day, index) => {
                  if (!day) return <span key={`pad-${index}`} aria-hidden="true" />;
                  const pickable = isPickableDay(day, todayKey, anchor, maxSpanDays);
                  const selected = inDraft(day);
                  return (
                    <button key={day} type="button" data-day={day} disabled={!pickable} aria-pressed={selected} aria-label={formatDayLabel(day, locale)}
                      tabIndex={day === (draftStart ?? todayKey) ? 0 : -1}
                      onClick={() => dayClick(day)} onKeyDown={event => onGridKeyDown(event, day)}
                      className={`min-h-[36px] rounded-md text-xs tabular-nums ${isDraftEdge(day) ? 'bg-brand-600 text-white font-semibold' : selected ? 'bg-brand-100 dark:bg-brand-900/40 text-slate-800 dark:text-slate-100' : 'text-slate-700 dark:text-slate-200'} ${pickable ? '' : 'opacity-35 cursor-not-allowed'} focus-visible:outline-2 focus-visible:outline-brand-500`}>
                      {Number(day.slice(8, 10))}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {activityMetric && draftStart && draftEnd ? (
            <ActivitySection metric={activityMetric} draftStart={draftStart} draftEnd={draftEnd} todayKey={todayKey} locale={locale} onDraftChange={(start, end) => { setDraftStart(start); setDraftEnd(end); setAnchor(null); }} />
          ) : null}

          <div className="text-xs text-slate-500 dark:text-slate-400" data-testid="date-range-draft">
            {draftStart && draftEnd ? formatDayLabel(draftStart, locale) + ' – ' + formatDayLabel(draftEnd, locale) : spanText}
            {customError ? <p role="alert" className="mt-1 text-red-600 dark:text-red-400">{t(errorKey(customError), { max: customError === 'tooLong' ? maxSpanDays : DATE_RANGE_MAX_AGE_DAYS })}</p> : null}
            <p className="mt-1">{t('hintUtc')}</p>
          </div>
          <div className="flex justify-end gap-2 pt-1 sticky bottom-0 bg-white dark:bg-slate-900">
            <button type="button" onClick={() => closePanel(true)} className="min-h-[36px] px-3 rounded-md text-xs border border-slate-200 dark:border-slate-700">{t('actions.cancel')}</button>
            <button type="button" data-testid="date-range-apply" disabled={!canApply} onClick={applyDraft}
              className="min-h-[36px] inline-flex items-center gap-1 px-3 rounded-md text-xs font-semibold bg-brand-600 text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-brand-500">
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              {t('actions.apply')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? closePanel(true) : openPanel())}
        data-testid="date-range-trigger"
        className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-xs text-left hover:border-brand-500 focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50"
      >
        <CalendarDays className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
        <span className="font-semibold text-slate-800 dark:text-slate-200">{triggerLabel}</span>
        {rangeText && <span className="text-slate-500 dark:text-slate-400 whitespace-nowrap">{rangeText}</span>}
      </button>
      {open && typeof document !== 'undefined' ? createPortal(panel, document.body) : null}
    </div>
  );
}

