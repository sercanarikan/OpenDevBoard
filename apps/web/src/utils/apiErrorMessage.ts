import { ApiError } from '../types/paging';

export function apiErrorTranslationKey(error: ApiError): 'api.timeout' | 'api.networkError' | 'api.pullRequestsLoading' | null {
  if (error.isLoading) return 'api.pullRequestsLoading';
  if (!error.isNetwork) return null;
  return error.message === 'timeout' ? 'api.timeout' : 'api.networkError';
}
