import { describe, expect, it } from 'vitest';
import headerSource from './Header.tsx?raw';

// Measured at 1200/1280 px the project select collapsed to 10-31 px when the full sync label and the
// language/density/Azure controls stayed inline next to the 276 px date trigger. The secondary controls
// and the full sync label now start at 1440 px; the command palette label stays at 1680 px.
describe('header responsive contract', () => {
  it('keeps secondary controls behind the More menu below 1440 px', () => {
    expect(headerSource).toMatch(/hidden min-\[1440px\]:flex items-center gap-2\.5 shrink-0/);
    expect(headerSource).toMatch(/relative min-\[1440px\]:hidden shrink-0/);
    expect(headerSource).not.toMatch(/min-\[1100px\]/);
  });

  it('shows the full sync label only from 1440 px and keeps the compact label with a tooltip below', () => {
    expect(headerSource).toMatch(/min-\[1440px\]:hidden">\{t\('status\.syncShort'\)\}/);
    expect(headerSource).toMatch(/hidden min-\[1440px\]:inline">\{syncLabel\}/);
    expect(headerSource).not.toMatch(/min-\[1280px\]/);
  });

  it('keeps the icon-only command palette trigger named and the label from 1680 px', () => {
    expect(headerSource).toMatch(/aria-label=\{t\('actions\.commandMenu'\)\}/);
    expect(headerSource).toMatch(/hidden min-\[1680px\]:inline">\{t\('actions\.commandMenu'\)\}/);
  });

  it('gives the project select a guaranteed minimum width', () => {
    expect(headerSource).toMatch(/min-w-\[7rem\] max-w-\[220px\] truncate/);
  });
});
