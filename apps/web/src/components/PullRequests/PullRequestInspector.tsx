import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  ExternalLink,
  GitBranch,
  User,
  Clock,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  FileText,
  Link as LinkIcon
} from 'lucide-react';
import type { PullRequest, PullRequestReviewer } from '../../types/paging';
import { useApp } from '../../context/useApp';
import { ReviewerRequirementBadge } from './ReviewerRequirementBadge';

interface PullRequestInspectorProps {
  pr: PullRequest;
  onClose: () => void;
}

export const PullRequestInspector: React.FC<PullRequestInspectorProps> = ({ pr, onClose }) => {
  const { t } = useTranslation(['pullRequests', 'common']);
  const { openWorkItem } = useApp();

  const getVoteBadge = (reviewer: PullRequestReviewer) => {
    switch (reviewer.vote) {
      case 10:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            <span>{t('votes.approved')}</span>
          </span>
        );
      case 5:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300 border border-teal-200 dark:border-teal-800">
            <CheckCircle2 className="w-3 h-3 text-teal-500" />
            <span>{t('votes.approvedWithSuggestions')}</span>
          </span>
        );
      case -5:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
            <AlertCircle className="w-3 h-3 text-amber-500" />
            <span>{t('votes.waitingForAuthor')}</span>
          </span>
        );
      case -10:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
            <AlertCircle className="w-3 h-3 text-rose-500" />
            <span>{t('votes.rejected')}</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-50 text-slate-600 dark:bg-slate-900/60 dark:text-slate-400 border border-slate-200 dark:border-slate-800">
            <HelpCircle className="w-3 h-3 text-slate-400" />
            <span>{t('votes.noVote')}</span>
          </span>
        );
    }
  };

  const getMergeStatusBadge = (mergeStatus: string) => {
    const s = (mergeStatus || '').toLowerCase();
    switch (s) {
      case 'succeeded':
        return (
          <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            <span>{t('inspector.mergeNoConflicts')}</span>
          </span>
        );
      case 'conflicts':
        return (
          <span className="text-rose-600 dark:text-rose-400 font-semibold flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            <span>{t('inspector.mergeHasConflicts')}</span>
          </span>
        );
      case 'queued':
        return (
          <span className="text-amber-600 dark:text-amber-400 font-semibold">
            {t('inspector.mergeQueued')}
          </span>
        );
      default:
        return (
          <span className="text-slate-400 font-medium">
            {t('inspector.mergeNotSet')}
          </span>
        );
    }
  };

  const getStatusBadge = (status: string, isDraft: number | boolean) => {
    if (isDraft) {
      return (
        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
          {t('status.draft')}
        </span>
      );
    }
    switch (status) {
      case 'active':
        return (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
            {t('status.active')}
          </span>
        );
      case 'completed':
        return (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
            {t('status.completed')}
          </span>
        );
      case 'abandoned':
        return (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
            {t('status.abandoned')}
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <aside
      data-testid="pr-inspector"
      data-id={pr.id}
      className="w-96 min-w-[340px] max-w-md border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0E131F] flex flex-col h-full z-10 select-text shrink-0 shadow-lg"
    >
      {/* Top Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-3 bg-slate-50/50 dark:bg-slate-900/40 shrink-0">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400">
              #{pr.id}
            </span>
            {getStatusBadge(pr.status, pr.isDraft)}
            <span className="text-xs text-slate-400 truncate">
              {pr.project} • {pr.repository}
            </span>
          </div>
          <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-100 leading-snug break-words">
            {pr.title}
          </h2>
        </div>

        <button
          onClick={onClose}
          aria-label={t('actions.close', { ns: 'common' })}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Main Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 text-xs">
        {/* Open in Azure DevOps Button */}
        {pr.url && (
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-lg bg-brand-50 hover:bg-brand-100 dark:bg-brand-950/60 dark:hover:bg-brand-900/60 text-brand-700 dark:text-brand-300 font-semibold border border-brand-200 dark:border-brand-800 transition-colors"
          >
            <span>{t('inspector.openInDevops')}</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}

        {/* Branches & Merge Status Card */}
        <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50 space-y-2">
          <div className="flex items-center gap-1.5 font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider text-[10px]">
            <GitBranch className="w-3.5 h-3.5 text-brand-500" />
            <span>{t('inspector.branches')}</span>
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px] bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-200/80 dark:border-slate-800">
            <span className="font-semibold text-slate-800 dark:text-slate-200 truncate" title={pr.sourceBranch}>
              {pr.sourceBranch}
            </span>
            <span className="text-slate-400">➔</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200 truncate" title={pr.targetBranch}>
              {pr.targetBranch}
            </span>
          </div>

          {pr.mergeStatus && pr.mergeStatus !== 'notset' && (
            <div className="flex items-center justify-between text-[11px] pt-1">
              <span className="text-slate-500">{t('inspector.mergeStatus')}</span>
              {getMergeStatusBadge(pr.mergeStatus)}
            </div>
          )}
        </div>

        {/* Author & Timestamps Card */}
        <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50 space-y-2">
          <div className="flex items-center gap-1.5 font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider text-[10px]">
            <User className="w-3.5 h-3.5 text-brand-500" />
            <span>{t('inspector.author')}</span>
          </div>

          <div className="flex items-center gap-2.5">
            {pr.authorAvatar ? (
              <img
                src={pr.authorAvatar}
                alt={pr.authorName}
                className="w-7 h-7 rounded-full object-cover border border-slate-200 dark:border-slate-700"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center font-bold text-[11px] text-slate-600 dark:text-slate-300">
                {pr.authorName.charAt(0)}
              </div>
            )}
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                {pr.authorName}
              </div>
              <div className="text-[11px] text-slate-400 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <span>{pr.creationDate ? new Date(pr.creationDate).toLocaleDateString() : '—'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Reviewers List */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider text-[10px]">
              {t('inspector.reviewers')} ({pr.reviewers.length})
            </span>
          </div>

          {pr.reviewers.length === 0 ? (
            <div className="p-3 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-slate-400 text-center italic">
              {t('empty.noPRs')}
            </div>
          ) : (
            <div className="space-y-1.5">
              {pr.reviewers.map(r => (
                <div
                  key={r.id || r.displayName}
                  className="p-2 px-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#121929] flex items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {r.avatar ? (
                      <img src={r.avatar} alt={r.displayName} className="w-6 h-6 rounded-full object-cover" />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[10px] font-bold text-slate-600 dark:text-slate-300">
                        {r.displayName.charAt(0)}
                      </div>
                    )}
                    <span className="font-medium text-slate-800 dark:text-slate-200 truncate" title={r.displayName}>
                      {r.displayName}
                    </span>
                    <ReviewerRequirementBadge
                      isRequired={Boolean(r.isRequired)}
                      label={t(r.isRequired ? 'inspector.required' : 'inspector.optional')}
                    />
                  </div>
                  <div className="shrink-0">{getVoteBadge(r)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Description Section */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider text-[10px]">
            <FileText className="w-3.5 h-3.5 text-brand-500" />
            <span>{t('inspector.description')}</span>
          </div>
          <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 text-slate-700 dark:text-slate-300 text-[11.5px] leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
            {pr.description ? pr.description : <span className="italic text-slate-400">{t('inspector.noDescription')}</span>}
          </div>
        </div>

        {/* Associated Work Items */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider text-[10px]">
            <LinkIcon className="w-3.5 h-3.5 text-brand-500" />
            <span>{t('inspector.workItems')} ({pr.workItems.length})</span>
          </div>

          {pr.workItems.length === 0 ? (
            <div className="p-2.5 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-slate-400 text-center italic text-[11px]">
              {t('inspector.noWorkItems')}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {pr.workItems.map(w => (
                <button
                  key={w.id}
                  onClick={() => openWorkItem(w.id)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-brand-50 hover:bg-brand-100 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300 border border-brand-200 dark:border-brand-800 transition-colors"
                  title={t('inspector.inspectWorkItem')}
                >
                  <span>#{w.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
