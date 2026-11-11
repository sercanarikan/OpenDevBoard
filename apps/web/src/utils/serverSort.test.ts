import { describe, it, expect } from 'vitest';
import { naturalSort } from './serverSort';

describe('naturalSort', () => {
  it('maps every field to its best-first server order', () => {
    expect(naturalSort('changedDate', false)).toEqual({ sortBy: 'changedDate', sortOrder: 'desc' });
    expect(naturalSort('priority', false)).toEqual({ sortBy: 'priority', sortOrder: 'asc' });
    expect(naturalSort('id', false)).toEqual({ sortBy: 'id', sortOrder: 'desc' });
    expect(naturalSort('title', false)).toEqual({ sortBy: 'title', sortOrder: 'asc' });
    expect(naturalSort('state', false)).toEqual({ sortBy: 'state', sortOrder: 'asc' });
  });

  it('inverts every field when requested', () => {
    expect(naturalSort('changedDate', true).sortOrder).toBe('asc');
    expect(naturalSort('priority', true).sortOrder).toBe('desc');
    expect(naturalSort('id', true).sortOrder).toBe('asc');
    expect(naturalSort('title', true).sortOrder).toBe('desc');
  });
});
