import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewerRequirementBadge } from './ReviewerRequirementBadge';

describe('ReviewerRequirementBadge', () => {
  it('visibly labels a required reviewer', () => {
    const html = renderToStaticMarkup(<ReviewerRequirementBadge isRequired label="Zorunlu" />);

    expect(html).toContain('aria-label="Zorunlu"');
    expect(html).toContain('>Zorunlu</span>');
  });

  it('visibly labels an optional reviewer', () => {
    const html = renderToStaticMarkup(<ReviewerRequirementBadge isRequired={false} label="Opsiyonel" />);

    expect(html).toContain('aria-label="Opsiyonel"');
    expect(html).toContain('>Opsiyonel</span>');
  });
});
