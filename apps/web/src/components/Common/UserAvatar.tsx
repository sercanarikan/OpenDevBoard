import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { User } from 'lucide-react';

interface UserAvatarProps {
  name?: string;
  avatarUrl?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  showTooltip?: boolean;
}

// Deterministic color palette for user initials
const AVATAR_COLORS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300 border-violet-200 dark:border-violet-800',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300 border-rose-200 dark:border-rose-800',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800',
  'bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300 border-teal-200 dark:border-teal-800',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800'
];

function getInitials(name: string): string {
  if (!name || name.trim().toLowerCase() === 'unassigned') return '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  // First letter of first name + first letter of last name
  const first = parts[0][0];
  const last = parts[parts.length - 1][0];
  return (first + last).toUpperCase();
}

function getAvatarColorClass(name: string): string {
  if (!name) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

export const UserAvatar: React.FC<UserAvatarProps> = ({
  name = '',
  avatarUrl,
  size = 'sm',
  className = '',
  showTooltip = true
}) => {
  const { t } = useTranslation();
  const [hasError, setHasError] = useState(false);

  const isUnassigned = !name || name.trim().toLowerCase() === 'unassigned';
  const initials = getInitials(name);
  const colorClass = getAvatarColorClass(name);

  // Size mapping
  const sizeClasses = {
    xs: 'w-3.5 h-3.5 text-[9px]',
    sm: 'w-4 h-4 text-[10px]',
    md: 'w-6 h-6 text-xs',
    lg: 'w-8 h-8 text-sm'
  };

  const currentSizeClass = sizeClasses[size] || sizeClasses.sm;

  if (isUnassigned) {
    return (
      <div
        className={`${currentSizeClass} rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-400 shrink-0 ${className}`}
        title={showTooltip ? t('fields.unassigned') : undefined}
      >
        <User className="w-2.5 h-2.5 opacity-70" />
      </div>
    );
  }

  // If avatar URL exists and hasn't failed, attempt to render img with graceful error fallback
  if (avatarUrl && !hasError) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        onError={() => setHasError(true)}
        className={`${currentSizeClass} rounded-full object-cover shrink-0 border border-slate-200/60 dark:border-slate-700/60 ${className}`}
        title={showTooltip ? name : undefined}
      />
    );
  }

  // Initials fallback
  return (
    <div
      className={`${currentSizeClass} rounded-full border flex items-center justify-center font-bold font-mono tracking-tighter shrink-0 select-none ${colorClass} ${className}`}
      title={showTooltip ? name : undefined}
    >
      {initials || <User className="w-2.5 h-2.5 opacity-80" />}
    </div>
  );
};
