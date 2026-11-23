// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import { DateRangeFilter } from './DateRangeFilter';
import { formatDayLabel, presetSelection } from '../../services/dateRange';

const noop = () => undefined;

describe('DateRangeFilter', () => {
  it('shows the rolling preset label and a closed dialog trigger by default', () => {
    const html = renderToStaticMarkup(<DateRangeFilter value={presetSelection('last30', '2026-11-24')} onApply={noop} />);
    expect(html).toContain('data-testid="date-range-trigger"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="date-range-panel"');
  });

  it('shows calendar dates for a month preset in the trigger', () => {
    const html = renderToStaticMarkup(<DateRangeFilter value={presetSelection('lastMonth', '2026-11-24')} onApply={noop} />);
    // The label follows the active UI language, so compare against the same formatter.
    expect(html).toContain(formatDayLabel('2026-10-01', i18n.language));
    expect(html).toContain(formatDayLabel('2026-10-31', i18n.language));
  });

  it('is disabled when requested', () => {
    const html = renderToStaticMarkup(<DateRangeFilter value={presetSelection('last7', '2026-11-24')} onApply={noop} disabled />);
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
