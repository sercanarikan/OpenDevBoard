import React from 'react';

interface ReviewerRequirementBadgeProps {
  isRequired: boolean;
  label: string;
}

export const ReviewerRequirementBadge: React.FC<ReviewerRequirementBadgeProps> = ({ isRequired, label }) => (
  <span
    aria-label={label}
    title={label}
    data-testid="reviewer-requirement"
    className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] leading-none font-semibold whitespace-nowrap shrink-0 ${
      isRequired
        ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/80 dark:text-amber-400 dark:border-amber-900'
        : 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-slate-800'
    }`}
  >
    {label}
  </span>
);
