import React from 'react';
import { useTranslation } from 'react-i18next';
import { Hourglass, Info } from 'lucide-react';
import { coverageNoticeKey, type CacheCoverage, type CacheJob } from '../../hooks/useCacheJob';

/** Compact notice about background collection for a calendar range. Local data stays visible. */
export const CacheJobNotice: React.FC<{ job: CacheJob | null; coverage: CacheCoverage | null }> = ({ job, coverage }) => {
  const { t } = useTranslation('common');
  const key = coverageNoticeKey(job, coverage);
  const deferred = job?.state === 'deferred';
  const busy = (job?.busy ?? 0) > 0;
  if (!key && !deferred && !busy) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300" data-testid="cache-job-notice" role="status">
      {key && (
        <span className="inline-flex items-center gap-1.5" data-testid={`cache-notice-${key}`}>
          <Hourglass className="w-3.5 h-3.5" aria-hidden="true" />
          {t(`cacheJob.${key}`)}
        </span>
      )}
      {deferred && (
        <span className="inline-flex items-center gap-1.5" data-testid="cache-notice-deferred">
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
          {t('cacheJob.deferred', { seconds: Math.ceil(job?.retryAfterSeconds ?? 0) })}
        </span>
      )}
      {busy && (
        <span className="inline-flex items-center gap-1.5" data-testid="cache-notice-busy">
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
          {t('cacheJob.busy')}
        </span>
      )}
    </div>
  );
};
