import { describe, expect, it } from 'vitest';
import { customSelection, periodSelection, presetSelection } from '../../../services/dateRange';
import { PRESET_MAIN, PRESET_MORE, draftFromPreset, draftFromSelection, parseDateInput, selectionFromDraft, validateDraft } from './draftModel';

const TODAY = '2026-11-25';

describe('draftModel', () => {
  it('keeps the most used presets visible and the rest under more periods', () => {
    expect(PRESET_MAIN).toEqual(['last7', 'last14', 'last30', 'last90', 'today', 'thisMonth', 'lastMonth', 'thisYear']);
    expect(PRESET_MORE).toContain('lastYear');
    expect(PRESET_MORE.filter(p => PRESET_MAIN.includes(p))).toEqual([]);
  });

  it('opens a rolling selection as calendar bounds computed from UTC today', () => {
    expect(draftFromSelection(presetSelection('last30', TODAY), TODAY)).toEqual({ start: '2026-10-27', end: '2026-11-25', preset: 'last30' });
  });

  it('treats a custom selection as having no preset', () => {
    expect(draftFromSelection(customSelection('2026-11-01', '2026-11-05'), TODAY).preset).toBeNull();
  });

  it('applies a preset draft as the preset selection, keeping rolling semantics', () => {
    expect(selectionFromDraft(draftFromPreset('last7', TODAY), TODAY)).toEqual(presetSelection('last7', TODAY));
    expect(selectionFromDraft(draftFromPreset('lastMonth', TODAY), TODAY)).toEqual(presetSelection('lastMonth', TODAY));
  });

  it('applies a full past period as that period and anything else as custom', () => {
    const month = periodSelection('month', { year: 2026, month: 9 }, TODAY);
    expect(selectionFromDraft({ start: '2026-09-01', end: '2026-09-30', preset: 'month' }, TODAY)).toEqual(month);
    expect(selectionFromDraft({ start: '2026-09-01', end: '2026-09-20', preset: 'month' }, TODAY)).toEqual(customSelection('2026-09-01', '2026-09-20'));
    expect(selectionFromDraft({ start: '2026-11-02', end: '2026-11-05', preset: null }, TODAY)).toEqual(customSelection('2026-11-02', '2026-11-05'));
  });

  it('validates drafts with the shared range rules', () => {
    expect(validateDraft('2026-11-01', '2026-11-10', TODAY)).toBeNull();
    expect(validateDraft('2026-11-01', '2026-12-10', TODAY)).toBe('future');
    expect(validateDraft('2026-11-10', '2026-11-01', TODAY)).toBe('endBeforeStart');
    expect(validateDraft('2020-01-01', '2026-11-01', TODAY)).toBe('tooLong');
    expect(validateDraft('nope', '2026-11-01', TODAY)).toBe('invalidDate');
  });

  it('parses typed dates strictly', () => {
    expect(parseDateInput(' 2026-11-05 ')).toBe('2026-11-05');
    expect(parseDateInput('2026-02-31')).toBeNull();
    expect(parseDateInput('5.11.2026')).toBeNull();
  });
});
