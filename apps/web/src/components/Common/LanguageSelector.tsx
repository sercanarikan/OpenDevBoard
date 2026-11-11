import React from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { changeLanguage, getCurrentLanguage } from '../../i18n';

export const LanguageSelector: React.FC = () => {
  const { t } = useTranslation();
  const currentLang = getCurrentLanguage();

  const toggleLanguage = () => {
    const nextLang = currentLang === 'tr' ? 'en' : 'tr';
    changeLanguage(nextLang);
  };

  return (
    <button
      onClick={toggleLanguage}
      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer select-none"
      title={t('language.switchLanguage')}
      aria-label={t('language.switchLanguage')}
    >
      <Globe className="w-3 h-3 text-slate-400" />
      <span className="font-mono">{currentLang === 'tr' ? 'TR' : 'EN'}</span>
    </button>
  );
};
