import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import commonTR from './locales/tr/common.json';
import kanbanTR from './locales/tr/kanban.json';
import dependenciesTR from './locales/tr/dependencies.json';
import pullRequestsTR from './locales/tr/pullRequests.json';
import dashboardTR from './locales/tr/dashboard.json';
import pipelinesTR from './locales/tr/pipelines.json';
import deploymentsTR from './locales/tr/deployments.json';
import teamActivityTR from './locales/tr/teamActivity.json';
import myHistoryTR from './locales/tr/myHistory.json';

import commonEN from './locales/en/common.json';
import kanbanEN from './locales/en/kanban.json';
import dependenciesEN from './locales/en/dependencies.json';
import pullRequestsEN from './locales/en/pullRequests.json';
import dashboardEN from './locales/en/dashboard.json';
import pipelinesEN from './locales/en/pipelines.json';
import deploymentsEN from './locales/en/deployments.json';
import teamActivityEN from './locales/en/teamActivity.json';
import myHistoryEN from './locales/en/myHistory.json';

const resources = {
  tr: {
    common: commonTR,
    kanban: kanbanTR,
    dependencies: dependenciesTR,
    pullRequests: pullRequestsTR,
    dashboard: dashboardTR,
    pipelines: pipelinesTR,
    deployments: deploymentsTR,
    teamActivity: teamActivityTR,
    myHistory: myHistoryTR
  },
  en: {
    common: commonEN,
    kanban: kanbanEN,
    dependencies: dependenciesEN,
    pullRequests: pullRequestsEN,
    dashboard: dashboardEN,
    pipelines: pipelinesEN,
    deployments: deploymentsEN,
    teamActivity: teamActivityEN,
    myHistory: myHistoryEN
  }
};

// Retrieve saved language preference or default to Turkish ('tr')
const savedLanguage = typeof window !== 'undefined'
  ? localStorage.getItem('devopsflow_language') || 'tr'
  : 'tr';

const syncDocumentLanguage = (language: string) => {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language.startsWith('en') ? 'en' : 'tr';
  }
};

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: savedLanguage,
    fallbackLng: 'tr',
    defaultNS: 'common',
    ns: ['common', 'kanban', 'dependencies', 'pullRequests', 'dashboard', 'pipelines', 'deployments', 'teamActivity', 'myHistory'],
    interpolation: {
      escapeValue: false // React already escapes values safely
    }
  });

syncDocumentLanguage(savedLanguage);

export const changeLanguage = (lng: 'tr' | 'en') => {
  i18n.changeLanguage(lng);
  syncDocumentLanguage(lng);
  if (typeof window !== 'undefined') {
    localStorage.setItem('devopsflow_language', lng);
  }
};

export const getCurrentLanguage = (): 'tr' | 'en' => {
  return (i18n.language?.startsWith('en') ? 'en' : 'tr');
};

export default i18n;
