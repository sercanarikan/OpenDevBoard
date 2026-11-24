import { describe, expect, it } from 'vitest';
import { ApiError } from '../types/paging';
import { apiErrorTranslationKey } from './apiErrorMessage';

describe('API error messages', () => {
  it('distinguishes a timeout from an unknown browser network error', () => {
    expect(apiErrorTranslationKey(new ApiError('timeout', 0, { isNetwork: true }))).toBe('api.timeout');
    expect(apiErrorTranslationKey(new ApiError('Failed to fetch', 0, { isNetwork: true }))).toBe('api.networkError');
  });

  it('keeps server responses available for their original error message', () => {
    expect(apiErrorTranslationKey(new ApiError('HTTP 403', 403))).toBeNull();
  });

  it('maps the bounded PR loading response to its own translated state', () => {
    expect(apiErrorTranslationKey(new ApiError('pullRequestsLoading', 503, {
      isLoading: true,
      payload: { cacheStatus: { outcome: 'loading' } },
      retryAfterMs: 2000
    }))).toBe('api.pullRequestsLoading');
  });
});
