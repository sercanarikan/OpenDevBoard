// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOnRangeChange, useRangeScopedPage } from './useRangeScopedPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('range scoped state', () => {
  let container: HTMLDivElement;
  let root: Root;
  let setPage: ReturnType<typeof useRangeScopedPage>[1];
  let page = 0;
  const onChange = vi.fn();
  const Probe = ({ rangeKey }: { rangeKey: string }) => {
    [page, setPage] = useRangeScopedPage(rangeKey);
    useOnRangeChange(rangeKey, onChange);
    return null;
  };

  beforeEach(() => {
    onChange.mockReset();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(async () => act(async () => root.unmount()));

  it('returns to page 1 as soon as the range changes, in the same render', async () => {
    await act(async () => root.render(<Probe rangeKey="a" />));
    await act(async () => setPage(3));
    expect(page).toBe(3);
    await act(async () => root.render(<Probe rangeKey="b" />));
    expect(page).toBe(1);
    await act(async () => setPage(p => p + 1));
    expect(page).toBe(2);
  });

  it('notifies about a range change but not on mount', async () => {
    await act(async () => root.render(<Probe rangeKey="a" />));
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => root.render(<Probe rangeKey="b" />));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
