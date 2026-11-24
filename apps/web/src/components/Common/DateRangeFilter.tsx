import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import {
  DATE_RANGE_MAX_AGE_DAYS,
  DATE_RANGE_MAX_SPAN_DAYS,
  addDaysToKey,
  buildMonthGrid,
  customSelection,
  formatDayLabel,
  isPickableDay,
  presetSelection,
  selectionDayCount,
  utcTodayKey,
  validateCustomRange,
  type CalendarPresetId,
  type CustomRangeError,
  type DateRangePresetId,
  type DateRangeSelection,
  type RollingPresetId
} from '../../services/dateRange';

export interface DateRangeFilterProps {
  value: DateRangeSelection;
  onApply: (selection: DateRangeSelection) => void;
  disabled?: boolean;
}

const ROLLING_ORDER: RollingPresetId[] = ['last7', 'last14', 'last30', 'last90'];
const CALENDAR_ORDER: CalendarPresetId[] = ['thisMonth', 'lastMonth'];

const monthStart = (key: string) => `${key.slice(0, 8)}01`;
const monthIndex = (key: string) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) - 1 });

function errorKey(error: CustomRangeError): string {
  return `errors.${error}`;
}

export function DateRangeFilter({ value, onApply, disabled = false }: DateRangeFilterProps) {
  const { t, i18n } = useTranslation('dateRange');
  const locale = i18n.language || 'en';
  const panelId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [todayKey, setTodayKey] = useState(() => utcTodayKey());
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const [draftEnd, setDraftEnd] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [viewMonth, setViewMonth] = useState(() => monthStart(utcTodayKey()));
  const [showCustom, setShowCustom] = useState(value.kind === 'calendar' && value.preset === 'custom');
  const [focusDay, setFocusDay] = useState<string | null>(null);
  // Horizontal offset that keeps the panel inside the viewport on narrow screens (measured on open).
  const [panelLeft, setPanelLeft] = useState(0);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewport = window.innerWidth;
    const width = Math.min(viewport - 32, 336);
    const target = Math.min(Math.max(16, rect.left), viewport - width - 16);
    setPanelLeft(target - rect.left);
  }, [open]);

  // Move focus into the dialog on open so keyboard users land on the current preset.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [open]);

  const triggerLabel = useMemo(() => {
    if (value.kind === 'rolling') return t(`presets.${value.preset}`);
    if (value.preset === 'custom') return t('presets.custom');
    return t(`presets.${value.preset}`);
  }, [value, t]);

  // Rolling presets already say "Last N days" in the label, so only calendar ranges add dates here.
  const rangeText = useMemo(() => {
    if (value.kind === 'rolling') return null;
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
    if (value.kind === 'calendar') {
      setDraftStart(value.startDate);
      setDraftEnd(value.endDate);
      setViewMonth(monthStart(value.startDate));
    } else {
      setDraftStart(null);
      setDraftEnd(null);
      setViewMonth(monthStart(today));
    }
    setAnchor(null);
    setShowCustom(value.kind === 'calendar' && value.preset === 'custom');
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  useEffect(() => {
    if (open && focusDay) {
      panelRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
    }
  }, [open, focusDay, viewMonth]);

  const choosePreset = (preset: DateRangePresetId) => {
    if (preset === 'custom') {
      setShowCustom(true);
      if (!draftStart || !draftEnd) {
        const fallback = presetSelection('thisMonth', utcTodayKey());
        if (fallback.kind === 'calendar') {
          setDraftStart(fallback.startDate);
          setDraftEnd(fallback.endDate);
          setViewMonth(monthStart(fallback.startDate));
        }
      }
      return;
    }
    onApply(presetSelection(preset, utcTodayKey()));
    closePanel(true);
  };

  const onDayPick = (day: string) => {
    if (!isPickableDay(day, todayKey, anchor)) return;
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

  const customError: CustomRangeError | null = draftStart && draftEnd
    ? validateCustomRange(draftStart, draftEnd, todayKey)
    : null;
  const canApply = Boolean(draftStart && draftEnd && !customError && !anchor);

  const applyCustom = () => {
    if (!canApply || !draftStart || !draftEnd) return;
    onApply(customSelection(draftStart, draftEnd));
    closePanel(true);
  };

  const { year, month } = monthIndex(viewMonth);
  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const weekdayLabels = useMemo(() => {
    // 2024-01-01 is a Monday, so these produce Monday-first narrow weekday names.
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, i) => formatter.format(new Date(Date.UTC(2024, 0, 1 + i))));
  }, [locale]);
  const monthTitle = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month, 1))),
    [locale, year, month]
  );

  // Month keys are `YYYY-MM-01`, so string comparison orders them correctly.
  const earliestMonth = monthStart(addDaysToKey(todayKey, -DATE_RANGE_MAX_AGE_DAYS));
  const canGoPrev = viewMonth > earliestMonth;
  const canGoNext = viewMonth < monthStart(todayKey);

  const moveMonth = (delta: number) => {
    const next = new Date(Date.UTC(year, month + delta, 1)).toISOString().slice(0, 10);
    setViewMonth(next);
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, day: string) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = offsets[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const target = addDaysToKey(day, delta);
    if (!isPickableDay(target, todayKey, anchor)) return;
    if (monthStart(target) !== viewMonth) setViewMonth(monthStart(target));
    setFocusDay(target);
  };

  const dayLabelFor = (day: string) => formatDayLabel(day, locale);
  const inDraft = (day: string) => Boolean(draftStart && draftEnd && day >= draftStart && day <= draftEnd);
  const isDraftEdge = (day: string) => day === draftStart || day === draftEnd;

  const spanText = draftStart && draftEnd
    ? t('summary.spanDays', { count: selectionDayCount(customSelection(draftStart, draftEnd)) })
    : t('summary.pickStart');

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

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          data-testid="date-range-panel"
          style={{ left: panelLeft, width: "min(calc(100vw - 2rem), 336px)" }}
          className="absolute top-full mt-2 z-50 flex flex-col gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg p-3"
        >
          <h2 id={titleId} className="sr-only">{t('title')}</h2>

          <div role="radiogroup" aria-label={t('title')} className="grid grid-cols-2 gap-1">
            {[...ROLLING_ORDER, ...CALENDAR_ORDER].map(preset => {
              const checked = value.preset === preset && !showCustom;
              return (
                <Fragment key={preset}>
                {preset === 'thisMonth' && (
                  <div className="col-span-2 h-px my-0.5 bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
                )}
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => choosePreset(preset)}
                  className={`flex items-center justify-between px-2 py-1.5 rounded-md text-xs font-medium border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500 ${
                    checked
                      ? 'border-brand-500 text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-slate-800'
                      : 'border-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {t(`presets.${preset}`)}
                  {checked && <Check className="w-3 h-3" aria-hidden="true" />}
                </button>
                </Fragment>
              );
            })}
            <button
              type="button"
              role="radio"
              aria-checked={showCustom}
              onClick={() => choosePreset('custom')}
              className={`col-span-2 flex items-center justify-between px-2 py-1.5 rounded-md text-xs font-medium border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500 ${
                showCustom
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-slate-800'
                  : 'border-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {t('presets.custom')}
              {showCustom && <Check className="w-3 h-3" aria-hidden="true" />}
            </button>
          </div>

          {showCustom && (
            <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-3" data-testid="date-range-custom">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  aria-label={t('calendar.previousMonth')}
                  disabled={!canGoPrev}
                  onClick={() => moveMonth(-1)}
                  className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200" aria-live="polite">{monthTitle}</div>
                <button
                  type="button"
                  aria-label={t('calendar.nextMonth')}
                  disabled={!canGoNext}
                  onClick={() => moveMonth(1)}
                  className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
                >
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <table role="grid" aria-label={monthTitle} className="w-full border-separate border-spacing-0.5 text-center">
                <thead>
                  <tr>
                    {weekdayLabels.map(label => (
                      <th key={label} scope="col" className="text-xs font-medium text-slate-500 pb-1">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {weeks.map((week, wi) => (
                    <tr key={wi}>
                      {week.map((day, di) => {
                        if (!day) return <td key={di} />;
                        const pickable = isPickableDay(day, todayKey, anchor);
                        const selected = isDraftEdge(day);
                        const ranged = inDraft(day) && !selected;
                        return (
                          <td key={di} className="p-0">
                            <div onKeyDown={e => onGridKeyDown(e, day)}>
                              <button
                                type="button"
                                data-day={day}
                                tabIndex={day === (focusDay ?? draftStart ?? todayKey) ? 0 : -1}
                                aria-label={dayLabelFor(day)}
                                aria-pressed={selected}
                                disabled={!pickable}
                                onClick={() => onDayPick(day)}
                                className={`w-full h-8 rounded text-xs tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500 ${
                                  selected
                                    ? 'bg-brand-600 text-white font-semibold'
                                    : ranged
                                      ? 'bg-brand-100 dark:bg-brand-900/40 text-slate-800 dark:text-slate-100'
                                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                                } ${!pickable ? 'opacity-30 cursor-not-allowed' : ''}`}
                              >
                                {Number(day.slice(8, 10))}
                              </button>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="text-xs text-slate-500 dark:text-slate-400" data-testid="date-range-draft">
                {draftStart && draftEnd
                  ? `${formatDayLabel(draftStart, locale)} – ${formatDayLabel(draftEnd, locale)} · ${spanText}`
                  : spanText}
              </div>
              {customError && (
                <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{t(errorKey(customError), { max: DATE_RANGE_MAX_SPAN_DAYS })}</p>
              )}
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('hintUtc')}</p>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => closePanel(true)}
                  className="px-2.5 py-1 rounded-md text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
                >
                  {t('actions.cancel')}
                </button>
                <button
                  type="button"
                  onClick={applyCustom}
                  disabled={!canApply}
                  data-testid="date-range-apply"
                  className="px-2.5 py-1 rounded-md text-xs font-semibold bg-brand-600 text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
                >
                  {t('actions.apply')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
