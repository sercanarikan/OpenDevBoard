// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import '../../i18n';
import { DescriptionView } from './DescriptionView';

const render = (props: Partial<React.ComponentProps<typeof DescriptionView>>) =>
  renderToStaticMarkup(<DescriptionView blocks={[]} {...props} />);

describe('DescriptionView', () => {
  it('shows loading, empty and load failure as three different states', () => {
    const loading = render({ loading: true });
    const empty = render({ status: 'empty' });
    const failed = render({ failed: true });
    expect(loading).toContain('data-testid="description-loading"');
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain('data-testid="description-empty"');
    expect(empty).not.toContain('description-error');
    expect(failed).toContain('data-state="error"');
    expect(failed).toContain('data-testid="description-error"');
    expect(failed).not.toContain('description-empty');
  });

  it('shows a status the server could not read as an error even without text', () => {
    expect(render({ status: 'unavailable' })).toContain('data-testid="description-error"');
  });

  it('keeps already available text visible next to a load error', () => {
    const html = render({ status: 'unavailable', blocks: [{ text: 'cached preview' }] });
    expect(html).toContain('cached preview');
    expect(html).toContain('data-testid="description-error"');
  });

  it('renders Bug repro steps with their own label next to the description', () => {
    const html = render({ status: 'available', blocks: [{ text: '<p>Body</p>' }, { label: 'Repro steps', text: '<ol><li>Open</li></ol>' }] });
    expect(html).toContain('Repro steps');
    expect(html).toContain('<ol><li>Open</li></ol>');
  });

  it('offers a visible control to read a long description in full', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const html = render({ status: 'available', blocks: [{ text: long }] });
    expect(html).toContain('data-testid="description-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('line 399');
    expect(render({ status: 'available', blocks: [{ text: 'short' }] })).not.toContain('description-toggle');
  });
});
