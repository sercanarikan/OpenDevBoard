import { describe, expect, it } from 'vitest';
import { parsePRFilter, pullRequestsPath } from './prFilter';

describe('pull request tab links', () => {
  it('opens the requested tab and falls back to needs-my-review', () => {
    expect(parsePRFilter('?prFilter=created-by-me')).toBe('created-by-me');
    expect(parsePRFilter('?project=X&prFilter=involved')).toBe('involved');
    expect(parsePRFilter('')).toBe('needs-my-review');
    expect(parsePRFilter('?prFilter=bogus')).toBe('needs-my-review');
  });

  it('builds a link that keeps the project', () => {
    expect(pullRequestsPath('created-by-me')).toBe('/pull-requests?prFilter=created-by-me');
    expect(pullRequestsPath('created-by-me', 'all')).toBe('/pull-requests?prFilter=created-by-me');
    expect(parsePRFilter(pullRequestsPath('created-by-me', 'Alpha').split('?')[1])).toBe('created-by-me');
    expect(pullRequestsPath('involved', 'Alpha')).toContain('project=Alpha');
  });
});
