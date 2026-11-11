import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Compass, ArrowLeft, LayoutDashboard } from 'lucide-react';

export const NotFoundView: React.FC = () => {
  const { t } = useTranslation(['common']);
  const navigate = useNavigate();

  return (
    <div
      data-testid="not-found-view"
      className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-slate-50 dark:bg-[#0B0F17] select-none"
    >
      <div className="w-16 h-16 rounded-2xl bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 flex items-center justify-center mb-4 border border-brand-200 dark:border-brand-800 shadow-sm">
        <Compass className="w-8 h-8 animate-pulse" />
      </div>

      <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 mb-2">
        404
      </span>

      <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight mb-2">
        {t('errors.pageNotFound', { defaultValue: 'Sayfa Bulunamadı' })}
      </h1>

      <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md mb-6 leading-relaxed">
        {t('errors.pageNotFoundDesc', {
          defaultValue: 'İstediğiniz adres mevcut değil veya taşınmış olabilir. Lütfen URL adresini kontrol edin veya ana panele dönün.'
        })}
      </p>

      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{t('actions.back', { defaultValue: 'Geri Dön' })}</span>
        </button>

        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold shadow-sm transition-colors"
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          <span>{t('views.dashboard')}</span>
        </button>
      </div>
    </div>
  );
};
