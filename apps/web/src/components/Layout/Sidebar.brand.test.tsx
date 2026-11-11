import { describe, expect, it } from 'vitest';
import sidebarSource from './Sidebar.tsx?raw';
import englishCommon from '../../i18n/locales/en/common.json?raw';
import turkishCommon from '../../i18n/locales/tr/common.json?raw';
import documentTitleSource from '../../../index.html?raw';
import brandLogoSource from '../Common/BrandLogo.tsx?raw';

describe('sidebar brand contract', () => {
  it('uses a concise localized subtitle and reserves space for two readable lines', () => {
    for (const locale of ['tr', 'en']) {
      const common = JSON.parse(locale === 'tr' ? turkishCommon : englishCommon);
      expect(common.appName).toBe('OpenDevBoard');
      expect(common.appSubtitle).toBe('Azure DevOps Dashboard');
    }

    expect(sidebarSource).not.toMatch(/\bPRO\b/);
    expect(sidebarSource).toMatch(/h-\[68px\]/);
    expect(sidebarSource).toMatch(/shrink-0 text-sm font-semibold leading-5/);
    expect(sidebarSource).toMatch(/whitespace-nowrap text-\[11px\]/);
    expect(sidebarSource.match(/<BrandLogo className="h-8 w-8/g)).toHaveLength(2);
    expect(sidebarSource).toMatch(/<BrandLogo[^>]*aria-hidden="true"/);
  });

  it('keeps production branding and SVG concepts in their intended locations', () => {
    const html = documentTitleSource;

    expect(html).toMatch(/<title>OpenDevBoard — Open-Source Dashboard for Azure DevOps<\/title>/);
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
    expect(sidebarSource).not.toMatch(/Sparkles/);
    expect(brandLogoSource).toMatch(/from ['"]\.\.\/\.\.\/assets\/dashboard-grid\.svg['"]/);
  });
});
