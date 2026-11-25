// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import { DashboardActivityCard } from './DashboardActivityCard';
import { DateRangeProvider } from '../../context/DateRangeContext';

const mockApp = vi.hoisted(() => ({ isDemo: true }));
vi.mock('../../context/useApp', () => ({ useApp: () => mockApp }));
vi.mock('../../services/liveApi', () => ({ fetchActivityDaily: vi.fn(), isTimeoutError: () => false }));

describe('DashboardActivityCard', () => {
  it('offers each activity source as its own metric and labels the card as period-based', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(<DateRangeProvider><DashboardActivityCard /></DateRangeProvider>);
    expect(html).toContain('data-testid="dash-activity-metric"');
    expect(html).toContain('Pipeline runs');
    expect(html).toContain('Deployments');
    expect(html).toContain('Commits');
    expect(html).toContain('Date filter applies to this card');
  });
});
