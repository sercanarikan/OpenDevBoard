import { ApiError } from '../types/paging';

export function apiErrorTranslationKey(error: ApiError): 'api.timeout' | 'api.networkError' | null {
  if (!error.isNetwork) return null;
  return error.message === 'timeout' ? 'api.timeout' : 'api.networkError';
}
