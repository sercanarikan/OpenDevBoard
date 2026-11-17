import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../types';
import type { PullRequest } from '../types/paging';
import { closeKind, pageKeyFromPath, refreshWorkItem, select, visibleSelection } from './selection';

const item = (id: number) => ({ id, title: `Item ${id}` }) as WorkItem;
const pr = (id: number) => ({ id, title: `PR ${id}` }) as PullRequest;

describe('selection', () => {
  it('uses the first path segment as the page', () => {
    expect(pageKeyFromPath('/tasks')).toBe('/tasks');
    expect(pageKeyFromPath('/tasks/')).toBe('/tasks');
    expect(pageKeyFromPath('/tasks/123')).toBe('/tasks');
    expect(pageKeyFromPath('/')).toBe('/');
  });

  it('hides a record on every page except the one it was opened on', () => {
    const open = select('workItem', '/tasks', item(1));
    expect(visibleSelection(open, '/tasks')).toBe(open);
    expect(visibleSelection(open, '/pull-requests')).toBeNull();
  });

  it('holds one record at a time: opening a pull request replaces the work item', () => {
    let slot = select('workItem', '/pull-requests', item(1));
    slot = select('pullRequest', '/pull-requests', pr(7));
    expect(slot?.kind).toBe('pullRequest');
  });

  it('closing a record that is not the open one leaves the open one alone', () => {
    const open = select('pullRequest', '/pull-requests', pr(7));
    expect(closeKind(open, 'workItem')).toBe(open);
    expect(closeKind(open, 'pullRequest')).toBeNull();
    expect(select('workItem', '/tasks', null)).toBeNull();
  });

  it('refreshes the open work item only when it is the same record', () => {
    const open = select('workItem', '/tasks', item(1));
    expect(refreshWorkItem(open, { ...item(1), title: 'Fresh' })).toMatchObject({ value: { title: 'Fresh' } });
    expect(refreshWorkItem(open, item(2))).toBe(open);
    const prOpen = select('pullRequest', '/tasks', pr(1));
    expect(refreshWorkItem(prOpen, item(1))).toBe(prOpen);
  });
});
