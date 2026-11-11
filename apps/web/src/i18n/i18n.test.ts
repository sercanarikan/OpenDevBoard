import { describe, it, expect, beforeEach, vi } from 'vitest';
import i18n, { changeLanguage, getCurrentLanguage } from './index';

describe('i18n Internationalization', () => {
  beforeEach(() => {
    changeLanguage('tr');
  });

  it('defaults to Turkish (tr)', () => {
    expect(getCurrentLanguage()).toBe('tr');
    expect(i18n.t('views.explorer')).toBe('Task Explorer');
    expect(i18n.t('workFocus.myTasks')).toBe('Görevlerim');
    expect(i18n.t('status.live')).toBe('Azure DevOps Live');
  });

  it('switches smoothly to English (en) and translates keys correctly', () => {
    changeLanguage('en');
    expect(getCurrentLanguage()).toBe('en');
    expect(i18n.t('workFocus.myTasks')).toBe('My Tasks');
    expect(i18n.t('fields.assignee')).toBe('Assignee');
    expect(i18n.t('kanban:columns.todo')).toBe('To Do & New');
    expect(i18n.t('dependencies:tabs.graph')).toBe('Interactive Graph');
  });

  it('keeps the document language in sync with the selected locale', () => {
    const documentElement = { lang: 'en' };
    vi.stubGlobal('document', { documentElement });
    try {
      changeLanguage('tr');
      expect(documentElement.lang).toBe('tr');
      changeLanguage('en');
      expect(documentElement.lang).toBe('en');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maintains technical terms in English when Turkish is active', () => {
    changeLanguage('tr');
    // Technical terms remain idiomatic as per spec
    expect(i18n.t('views.board')).toBe('Kanban Board');
    expect(i18n.t('views.hierarchy')).toBe('Story & Tasks');
    expect(i18n.t('views.dependencies')).toBe('Dependency Graph');
    expect(i18n.t('fields.storyPoints')).toBe('Story Points');
    expect(i18n.t('fields.iteration')).toBe('Iteration');
  });

  it('interpolates counts and loaded/active numbers accurately', () => {
    changeLanguage('tr');
    const msg = i18n.t('projects.loadedOfActive', { loaded: 258, total: 1144 });
    expect(msg).toBe('258 yüklendi / 1144 aktif');

    changeLanguage('en');
    const msgEn = i18n.t('projects.loadedOfActive', { loaded: 258, total: 1144 });
    expect(msgEn).toBe('258 loaded / 1144 active');
  });
});
