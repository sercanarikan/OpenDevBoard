const LOCALE_MAP = { tr: 'tr-TR', en: 'en-US' } as const;

export type AppLanguage = keyof typeof LOCALE_MAP;

export function formatDate(value: string | Date, lang: AppLanguage = 'tr'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALE_MAP[lang], { day: '2-digit', month: 'short' }).format(date);
}

export function formatDateTime(value: string | Date, lang: AppLanguage = 'tr'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALE_MAP[lang], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export function formatNumber(value: number, lang: AppLanguage = 'tr'): string {
  return new Intl.NumberFormat(LOCALE_MAP[lang]).format(value);
}
