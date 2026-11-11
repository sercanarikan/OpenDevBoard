import { describe, expect, it } from 'vitest';
import { getViewFromPath } from './routes';
import { getHeaderTitleKey } from './routeState';

describe('unknown route view state', () => {
  it('does not assign a module view to an unknown pathname', () => {
    expect(getViewFromPath('/unknown-route')).toBeNull();
  });

  it('resolves an unknown route to the not-found title key', () => {
    expect(getHeaderTitleKey(null)).toBe('errors.pageNotFound');
  });
});
