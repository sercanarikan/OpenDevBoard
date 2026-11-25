import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  DATE_RANGE_MAX_AGE_DAYS,
  DATE_RANGE_MAX_SPAN_DAYS,
  addDaysToKey,
  dayCountInclusive,
  formatDayLabel,
  isPickableDay,
  periodSelection,
  utcTodayKey,
  type CustomRangeError,
  type DateRangePresetId,
  type DateRangeSelection,
  type PeriodKind,
} from '../../services/dateRange';
import { DASHBOARD_ACTIVITY_METRICS, selectionBounds, type ActivityMetric } from '../../services/activityDaily';
import { ActivityCalendar } from './dateRange/ActivityCalendar';
import { ActivityTimeline } from './dateRange/ActivityTimeline';
import { useActivityDaily } from './dateRange/useActivityDaily';
import type { TimelineGranularity } from './dateRange/activityModel';
import { PRESET_MAIN, PRESET_MORE, draftFromPreset, draftFromSelection, parseDateInput, selectionFromDraft, validateDraft, type Draft } from './dateRange/draftModel';
import './dateRange/dateRangePicker.css';

export interface DateRangeFilterProps {
  /** The applied selection. The picker edits a draft of it and only reports a change through `onApply`. */
  value: DateRangeSelection;
  onApply: (selection: DateRangeSelection) => void;
  disabled?: boolean;
  /** Activity metrics offered by the heatmap selector; the global filter passes the active screen's list. */
  metrics?: ActivityMetric[];
}

type PeriodView = 'month' | 'quarter' | 'year';
const PERIOD_VIEWS: PeriodView[] = ['month', 'quarter', 'year'];
const GRANULARITIES: TimelineGranularity[] = ['day', 'week', 'month'];
const ALL_PRESETS: DateRangePresetId[] = [...PRESET_MAIN, ...PRESET_MORE];
const CATALOG_DAYS = 364;
const TIMELINE_DEFAULT_DAYS = 60;
const YEARS_PER_PAGE = 12;

const monthStart = (key: string) => `${key.slice(0, 8)}01`;
const yearOf = (key: string) => Number(key.slice(0, 4));
const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

function placementFor(trigger: HTMLElement | null) {
  if (!trigger) return null;
  const vw = window.innerWidth;
  if (vw < 640) return { mode: 'sheet' as const };
  const rect = trigger.getBoundingClientRect();
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const gap = 8;
  const width = Math.min(vw - 32, 720);
  const left = Math.min(Math.max(16, rect.right - width), vw - width - 16);
  const spaceBelow = vh - rect.bottom - 16 - gap;
  const spaceAbove = rect.top - 16 - gap;
  const placeBelow = spaceBelow >= 360 || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(280, placeBelow ? spaceBelow : spaceAbove);
  return placeBelow
    ? { mode: 'popover' as const, left, width, top: rect.bottom + gap, maxHeight }
    : { mode: 'popover' as const, left, width, bottom: vh - rect.top + gap, maxHeight };
}
type Placement = NonNullable<ReturnType<typeof placementFor>>;

interface PanelProps {
  value: DateRangeSelection;
  titleId: string;
  panelId: string;
  placement: Placement;
  locale: string;
  onApply: (selection: DateRangeSelection) => void;
  onClose: () => void;
  metrics: ActivityMetric[];
}

/** The open picker. It mounts only while open, so the draft always starts from the applied selection. */
function PickerPanel({ value, titleId, panelId, placement, locale, onApply, onClose, metrics }: PanelProps) {
  const { t } = useTranslation('dateRange');
  const [todayKey] = useState(() => utcTodayKey());
  const earliestKey = addDaysToKey(todayKey, -(DATE_RANGE_MAX_AGE_DAYS - 1));
  const [draft, setDraft] = useState<Draft>(() => draftFromSelection(value, todayKey));
  const [typed, setTyped] = useState<{ start: string; end: string } | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  // Which field the next calendar click sets (from the field's calendar button); null = two-click range.
  const [fieldTarget, setFieldTarget] = useState<'start' | 'end' | null>(null);
  const [viewMonth, setViewMonth] = useState(() => monthStart(draftFromSelection(value, todayKey).end));
  const [periodOpen, setPeriodOpen] = useState(false);
  const [periodView, setPeriodView] = useState<PeriodView>('month');
  const [periodYear, setPeriodYear] = useState(() => yearOf(draftFromSelection(value, todayKey).end));
  const [yearPageEnd, setYearPageEnd] = useState(() => yearOf(todayKey));
  const [moreOpen, setMoreOpen] = useState(() => PRESET_MORE.includes(draftFromSelection(value, todayKey).preset as DateRangePresetId));
  const [selectedMetric, setMetric] = useState<ActivityMetric>(metrics[0] ?? 'pipelines');
  // The route decides which metrics exist; a selection that is no longer offered falls back to the first one.
  const metric: ActivityMetric = metrics.includes(selectedMetric) ? selectedMetric : (metrics[0] ?? 'pipelines');
  const [granularity, setGranularity] = useState<TimelineGranularity>('day');
  const [info, setInfo] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);

  const lo = draft.start <= draft.end ? draft.start : draft.end;
  const hi = draft.start <= draft.end ? draft.end : draft.start;

  // The heatmap and the timeline read cached coverage only; nothing here starts an upstream refresh.
  const timelineStart = lo < addDaysToKey(todayKey, -(TIMELINE_DEFAULT_DAYS - 1)) ? lo : addDaysToKey(todayKey, -(TIMELINE_DEFAULT_DAYS - 1));
  const earliestWanted = [addDaysToKey(todayKey, -CATALOG_DAYS), `${viewMonth.slice(0, 4)}-01-01`, `${lo.slice(0, 4)}-01-01`].sort()[0];
  const floor = addDaysToKey(todayKey, -(DATE_RANGE_MAX_SPAN_DAYS - 1));
  const catalogStart = earliestWanted < floor ? floor : earliestWanted;
  const { data, error, loading } = useActivityDaily({ metric, startDate: catalogStart, endDate: todayKey, mode: 'cache', enabled: true });
  const timelineDays = useMemo(() => (data ? data.days.filter(d => d.date >= (timelineStart < catalogStart ? catalogStart : timelineStart)) : []), [data, timelineStart, catalogStart]);
  const job = data?.job;

  const setNextDraft = (next: Draft) => {
    setDraft(next);
    setTyped(null);
    setAnchor(null);
    setFieldTarget(null);
  };

  const showMonthOf = (date: string) => {
    const month = monthStart(date);
    setViewMonth(month);
    setPeriodYear(yearOf(date));
  };

  useEffect(() => {
    const target = panelRef.current?.querySelector<HTMLElement>('[data-preset][aria-pressed="true"]') ?? panelRef.current?.querySelector<HTMLElement>('[data-preset]');
    (target && target.offsetParent !== null ? target : panelRef.current)?.focus();
  }, []);

  useLayoutEffect(() => {
    const date = pendingFocus.current;
    if (!date) return;
    pendingFocus.current = null;
    panelRef.current?.querySelector<HTMLElement>(`[data-date="${date}"]`)?.focus();
  }, [viewMonth]);

  const choosePreset = (preset: DateRangePresetId) => {
    const next = draftFromPreset(preset, todayKey);
    setNextDraft(next);
    setInfo('');
    showMonthOf(next.end);
    setPeriodOpen(false);
    if (PRESET_MORE.includes(preset)) setMoreOpen(true);
  };

  const chooseFieldTarget = (field: 'start' | 'end') => {
    if (fieldTarget === field) {
      setFieldTarget(null);
      setInfo('');
      return;
    }
    setAnchor(null);
    setFieldTarget(field);
    setInfo(t(field === 'start' ? 'fields.pickHintStart' : 'fields.pickHintEnd'));
  };

  const pickDay = (date: string) => {
    if (!isPickableDay(date, todayKey, anchor)) return;
    if (fieldTarget) {
      // One field at a time: the other field keeps its value. Order and future checks stay in validateDraft.
      const next = fieldTarget === 'start' ? { start: date, end: draft.end, preset: null } : { start: draft.start, end: date, preset: null };
      setFieldTarget(null);
      setInfo('');
      setNextDraft(next);
      showMonthOf(date);
      return;
    }
    if (anchor === null) {
      setDraft({ start: date, end: date, preset: null });
      setTyped(null);
      setAnchor(date);
      return;
    }
    const [start, end] = date < anchor ? [date, anchor] : [anchor, date];
    setNextDraft({ start, end, preset: null });
  };

  const moveFocus = (from: string, delta: number) => {
    const target = addDaysToKey(from, delta);
    if (target > todayKey || target < earliestKey) return;
    const element = panelRef.current?.querySelector<HTMLElement>(`[data-date="${target}"]`);
    if (element) {
      element.focus();
      return;
    }
    pendingFocus.current = target;
    showMonthOf(target);
  };

  const moveMonth = (delta: number) => {
    const [y, m] = [yearOf(viewMonth), Number(viewMonth.slice(5, 7)) - 1];
    const next = new Date(Date.UTC(y, m + delta, 1)).toISOString().slice(0, 10);
    if (next > monthStart(todayKey) || next < monthStart(earliestKey)) return;
    showMonthOf(next);
  };

  // A period still in progress is drafted up to today, never into the future.
  const choosePeriod = (kind: PeriodKind, params: { year: number; month?: number; quarter?: number }) => {
    const selection = periodSelection(kind, params, todayKey);
    if (selection.kind !== 'calendar') return;
    const end = selection.endDate > todayKey ? todayKey : selection.endDate;
    setNextDraft({ start: selection.startDate, end, preset: end === selection.endDate ? kind : null });
    setInfo('');
    showMonthOf(kind === 'year' ? end : selection.startDate);
    setPeriodOpen(false);
  };
  const periodDisabled = (start: string, end: string) => start > todayKey || end < earliestKey;

  const onStartInput = (text: string) => {
    setFieldTarget(null);
    const nextTyped = { start: text, end: typed?.end ?? draft.end };
    setTyped(nextTyped);
    const parsed = parseDateInput(text);
    if (parsed) {
      setDraft({ start: parsed, end: draft.end, preset: null });
      setAnchor(null);
      if (parsed <= draft.end) showMonthOf(parsed);
    }
  };
  const onEndInput = (text: string) => {
    setFieldTarget(null);
    const nextTyped = { start: typed?.start ?? draft.start, end: text };
    setTyped(nextTyped);
    const parsed = parseDateInput(text);
    if (parsed) {
      setDraft({ start: draft.start, end: parsed, preset: null });
      setAnchor(null);
      if (parsed <= todayKey && parsed >= draft.start) showMonthOf(parsed);
    }
  };

  const startText = typed?.start ?? draft.start;
  const endText = typed?.end ?? draft.end;
  const inputInvalid = parseDateInput(startText) === null || parseDateInput(endText) === null;
  const rangeError: CustomRangeError | null = inputInvalid ? 'invalidDate' : validateDraft(draft.start, draft.end, todayKey);
  const canApply = !rangeError && anchor === null;
  const spanText = !rangeError ? t('summary.spanDays', { count: dayCountInclusive(draft.start, draft.end) }) : '';

  const apply = () => {
    if (!canApply) return;
    onApply(selectionFromDraft(draft, todayKey));
    onClose();
  };

  const [viewYear, viewMonthIndex] = [yearOf(viewMonth), Number(viewMonth.slice(5, 7)) - 1];
  const monthTitle = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(viewYear, viewMonthIndex, 1)));
  const canPrev = viewMonth > monthStart(earliestKey);
  const canNext = viewMonth < monthStart(todayKey);
  const firstDayOfView = viewMonth;
  const rovingDate = lo.slice(0, 7) === viewMonth.slice(0, 7) ? lo : firstDayOfView;
  const currentYear = yearOf(todayKey);
  const earliestYear = yearOf(earliestKey);

  const monthName = (m: number) => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, m - 1, 1)));

  const style = placement.mode === 'popover' ? { left: placement.left, width: placement.width, top: placement.top, bottom: placement.bottom, maxHeight: placement.maxHeight } : undefined;

  const presetButton = (preset: DateRangePresetId) => (
    <button key={preset} type="button" className="drp-preset" data-preset={preset} aria-pressed={draft.preset === preset} onClick={() => choosePreset(preset)}>
      {t(`presets.${preset}`)}
    </button>
  );

  return (
    <div ref={panelRef} id={panelId} role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1} data-testid="date-range-panel" data-mode={placement.mode} className="drp-panel" style={style}>
      <div className="drp-head">
        <h2 id={titleId}>{t('title')}</h2>
        <select className="drp-select" data-testid="date-range-metric" aria-label={t('activity.metricLabel')} value={metric} onChange={event => setMetric(event.target.value as ActivityMetric)}>
          {metrics.map(item => <option key={item} value={item}>{t(`activity.metrics.${item}`)}</option>)}
        </select>
        {data?.fixture ? <span className="drp-tag" data-testid="date-range-fixture">{t('activity.fixture')}</span> : null}
        <button type="button" className="drp-icon drp-close" data-testid="date-range-close" aria-label={t('close')} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </div>

      <div className="drp-mpresets">
        <select
          data-testid="date-range-preset-select"
          aria-label={t('presetSelect')}
          value={draft.preset ?? ''}
          onChange={event => event.target.value && choosePreset(event.target.value as DateRangePresetId)}
        >
          {draft.preset === null ? <option value="" disabled>{t('presets.custom')}</option> : null}
          {ALL_PRESETS.map(preset => <option key={preset} value={preset}>{t(`presets.${preset}`)}</option>)}
        </select>
      </div>

      <div className="drp-main">
        <nav className="drp-presets" aria-label={t('presetList')}>
          {PRESET_MAIN.map(presetButton)}
          <details className="drp-more" data-testid="date-range-more" open={moreOpen} onToggle={event => setMoreOpen(event.currentTarget.open)}>
            <summary>{t('more')}</summary>
            {PRESET_MORE.map(presetButton)}
          </details>
        </nav>

        <div className="drp-cal">
          <div className="drp-calhead">
            <button type="button" className="drp-icon" aria-label={t('calendar.previousMonth')} disabled={!canPrev} onClick={() => moveMonth(-1)}><ChevronLeft size={16} aria-hidden="true" /></button>
            <button type="button" className="drp-title" data-testid="date-range-title" aria-expanded={periodOpen} aria-controls="drp-period" onClick={() => setPeriodOpen(open => !open)}>{monthTitle}</button>
            <button type="button" className="drp-icon" aria-label={t('calendar.nextMonth')} disabled={!canNext} onClick={() => moveMonth(1)}><ChevronRight size={16} aria-hidden="true" /></button>
          </div>

          {periodOpen ? (
            <div id="drp-period" data-testid="date-range-period" className="space-y-2">
              <div className="drp-seg" role="group" aria-label={t('periodView.label')}>
                {PERIOD_VIEWS.map(view => (
                  <button key={view} type="button" data-view={view} aria-pressed={periodView === view} onClick={() => setPeriodView(view)}>{t(`periodView.${view}`)}</button>
                ))}
              </div>
              <div className="drp-periodnav">
                <button
                  type="button"
                  className="drp-icon"
                  data-testid="date-range-period-prev"
                  aria-label={periodView === 'year' ? t('period.previousYears') : t('period.previousYear')}
                  disabled={periodView !== 'year' && periodYear <= earliestYear}
                  onClick={() => (periodView === 'year' ? setYearPageEnd(yearPageEnd - YEARS_PER_PAGE) : setPeriodYear(periodYear - 1))}
                ><ChevronLeft size={16} aria-hidden="true" /></button>
                <span data-testid="date-range-period-label">
                  {periodView === 'year' ? t('period.yearsRange', { from: yearPageEnd - YEARS_PER_PAGE + 1, to: yearPageEnd }) : periodYear}
                </span>
                <button
                  type="button"
                  className="drp-icon"
                  data-testid="date-range-period-next"
                  aria-label={periodView === 'year' ? t('period.nextYears') : t('period.nextYear')}
                  disabled={periodView === 'year' ? yearPageEnd >= currentYear : periodYear >= currentYear}
                  onClick={() => (periodView === 'year' ? setYearPageEnd(Math.min(currentYear, yearPageEnd + YEARS_PER_PAGE)) : setPeriodYear(periodYear + 1))}
                ><ChevronRight size={16} aria-hidden="true" /></button>
              </div>
              <div className="drp-periodgrid cols-4">
                {periodView === 'month' && Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                  const start = `${periodYear}-${pad(m)}-01`;
                  const end = `${periodYear}-${pad(m)}-${pad(lastDayOfMonth(periodYear, m))}`;
                  return (
                    <button key={m} type="button" className="drp-pbtn" data-month={m} disabled={periodDisabled(start, end)} aria-pressed={draft.start === start && draft.end === (end > todayKey ? todayKey : end)} onClick={() => choosePeriod('month', { year: periodYear, month: m })}>
                      {monthName(m)}
                    </button>
                  );
                })}
                {periodView === 'quarter' && [1, 2, 3, 4].map(q => {
                  const startMonth = (q - 1) * 3 + 1;
                  const start = `${periodYear}-${pad(startMonth)}-01`;
                  const end = `${periodYear}-${pad(startMonth + 2)}-${pad(lastDayOfMonth(periodYear, startMonth + 2))}`;
                  return (
                    <button key={q} type="button" className="drp-pbtn" data-quarter={q} disabled={periodDisabled(start, end)} aria-pressed={draft.start === start && draft.end === (end > todayKey ? todayKey : end)} onClick={() => choosePeriod('quarter', { year: periodYear, quarter: q })}>
                      {t('period.quarterLabel', { quarter: q })}
                    </button>
                  );
                })}
                {periodView === 'year' && Array.from({ length: YEARS_PER_PAGE }, (_, i) => yearPageEnd - i).map(y => (
                  <button key={y} type="button" className="drp-pbtn" data-year={y} disabled={periodDisabled(`${y}-01-01`, `${y}-12-31`)} aria-pressed={draft.start === `${y}-01-01` && draft.end === (y === currentYear ? todayKey : `${y}-12-31`)} onClick={() => choosePeriod('year', { year: y })}>
                    {y}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <ActivityCalendar
            days={data?.days ?? null}
            viewMonth={viewMonth}
            start={lo}
            end={hi}
            todayKey={todayKey}
            earliestKey={earliestKey}
            metric={metric}
            locale={locale}
            rovingDate={rovingDate}
            onPick={pickDay}
            onMove={moveFocus}
            onInfo={setInfo}
          />

          <ul className="drp-legend" data-testid="date-range-legend">
            <li><i style={{ background: 'var(--drp-hover)' }} />{t('activity.legend.coveredZero')}</li>
            <li><span className="drp-scale" aria-hidden="true">{[1, 2, 3, 4, 5, 6].map(n => <i key={n} style={{ background: `var(--drp-b${n})` }} />)}</span>{t('activity.legend.coveredActive')}</li>
            <li><i style={{ background: 'var(--drp-hatch), var(--drp-surface)' }} />{t('activity.legend.partial')}</li>
            <li><i style={{ border: '1px dashed var(--drp-muted)' }} />{t('activity.legend.notCollected')}</li>
            <li><i style={{ border: '1px dotted var(--drp-muted)' }} />{t('activity.legend.unavailable')}</li>
            <li><i style={{ background: 'var(--drp-text)', width: 4, height: 4, borderRadius: '50%' }} />{t('activity.legend.stale')}</li>
          </ul>

          {loading && !data ? <p role="status" className="drp-status">{t('activity.loading')}</p> : null}
          {error ? <p role="alert" className="drp-status bad">{t(error === 'timeout' ? 'activity.timeout' : 'activity.loadFailed')}</p> : null}
          {job?.state === 'running' ? <p role="status" className="drp-status">{t('activity.job.running', { total: job.pending })}</p> : null}
          {job?.state === 'partial' ? <p role="status" className="drp-status warn">{t('activity.job.partial')}</p> : null}
          {job?.state === 'failed' ? <p role="status" className="drp-status bad">{t('activity.job.failed')}</p> : null}

          {timelineDays.length > 0 ? (
            <div data-testid="date-range-activity">
              <div className="drp-tlhead">
                <span>{t('timeline.name')}</span>
                <span className="drp-seg" role="group" aria-label={t('granularity.label')}>
                  {GRANULARITIES.map(item => (
                    <button key={item} type="button" data-granularity={item} aria-pressed={granularity === item} onClick={() => setGranularity(item)}>{t(`granularity.${item}`)}</button>
                  ))}
                </span>
              </div>
              <ActivityTimeline days={timelineDays} draftStart={lo} draftEnd={hi} locale={locale} granularity={granularity} compact onDraftChange={(start, end) => setNextDraft({ start, end, preset: null })} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="drp-foot">
        <label className="drp-field">
          <span>{t('fields.start')}</span>
          <span className="drp-input-row">
            <input data-testid="date-range-start" inputMode="numeric" placeholder={t('fields.placeholder')} aria-invalid={Boolean(rangeError)} aria-describedby="drp-error" value={startText} onChange={event => onStartInput(event.target.value)} />
            <button type="button" className="drp-icon drp-pick" data-testid="date-range-start-pick" aria-label={t('fields.pickStart')} aria-pressed={fieldTarget === 'start'} title={t('fields.pickStart')} onClick={() => chooseFieldTarget('start')}><CalendarDays size={16} aria-hidden="true" /></button>
          </span>
        </label>
        <label className="drp-field">
          <span>{t('fields.end')}</span>
          <span className="drp-input-row">
            <input data-testid="date-range-end" inputMode="numeric" placeholder={t('fields.placeholder')} aria-invalid={Boolean(rangeError)} aria-describedby="drp-error" value={endText} onChange={event => onEndInput(event.target.value)} />
            <button type="button" className="drp-icon drp-pick" data-testid="date-range-end-pick" aria-label={t('fields.pickEnd')} aria-pressed={fieldTarget === 'end'} title={t('fields.pickEnd')} onClick={() => chooseFieldTarget('end')}><CalendarDays size={16} aria-hidden="true" /></button>
          </span>
        </label>
        <div className="drp-actions">
          <button type="button" className="drp-btn" data-testid="date-range-cancel" onClick={onClose}>{t('actions.cancel')}</button>
          <button type="button" className="drp-btn p" data-testid="date-range-apply" disabled={!canApply} onClick={apply}>{t('actions.apply')}</button>
        </div>
        <p id="drp-error" role="alert" data-testid="date-range-error" className="drp-err">
          {rangeError ? t(`errors.${rangeError}`, { max: rangeError === 'tooLong' ? DATE_RANGE_MAX_SPAN_DAYS : DATE_RANGE_MAX_AGE_DAYS }) : ''}
        </p>
        <div className="drp-meta">
          <span>{spanText}</span>
          <span data-testid="date-range-info">{info || t('hintUtc')}</span>
        </div>
      </div>
    </div>
  );
}

export function DateRangeFilter({ value, onApply, disabled = false, metrics = DASHBOARD_ACTIVITY_METRICS }: DateRangeFilterProps) {
  const { t, i18n } = useTranslation('dateRange');
  const locale = i18n.language || 'en';
  const panelId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
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
    // updatePlacement reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (document.querySelector('[data-testid="date-range-panel"]')?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
    // close only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const triggerLabel = t(`presets.${value.preset}`);
  const rangeText = useMemo(() => {
    const { startDate, endDate } = selectionBounds(value, utcTodayKey());
    return startDate === endDate ? formatDayLabel(startDate, locale) : `${formatDayLabel(startDate, locale)} – ${formatDayLabel(endDate, locale)}`;
  }, [value, locale]);

  return (
    <div className="relative inline-block min-w-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(current => !current)}
        data-testid="date-range-trigger"
        className="inline-flex max-w-full items-center gap-2 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-xs text-left hover:border-brand-500 focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50"
      >
        <CalendarDays className="w-3.5 h-3.5 shrink-0 text-slate-500" aria-hidden="true" />
        <span className="font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">{triggerLabel}</span>
        <span className="hidden min-[480px]:inline text-slate-500 dark:text-slate-400 whitespace-nowrap tabular-nums">{rangeText}</span>
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(<PickerPanel value={value} titleId={titleId} panelId={panelId} placement={placement} locale={locale} onApply={onApply} onClose={() => close(true)} metrics={metrics} />, document.body)
        : null}
    </div>
  );
}
