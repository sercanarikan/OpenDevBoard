import type { ViewMode } from '../types';

export function getHeaderTitleKey(view: ViewMode | null): string | null {
  return view === null ? 'errors.pageNotFound' : null;
}
