import { describe, expect, it } from 'vitest';
import en from './locales/en/pullRequests.json';
import tr from './locales/tr/pullRequests.json';

// Azure DevOps pull requests have exactly three statuses (active, completed, abandoned; draft is a separate flag).
// "Open", "Merged" and "Closed" are not separate Azure DevOps states, so each status gets one label, not "A (B)".
describe('pull request status labels', () => {
  it.each([['en', en], ['tr', tr]])('%s uses one label per Azure DevOps status', (_locale, bundle) => {
    for (const key of ['active', 'completed', 'abandoned'] as const) {
      expect(bundle.status[key]).not.toMatch(/[()]/);
    }
    expect(bundle.status.draft).not.toBe(bundle.status.active);
  });

  it('matches the Azure DevOps names in English', () => {
    expect([en.status.active, en.status.completed, en.status.abandoned]).toEqual(['Active', 'Completed', 'Abandoned']);
  });
});
