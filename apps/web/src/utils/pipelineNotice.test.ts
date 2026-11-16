import { describe, expect, it } from 'vitest';
import { getPipelineNotice } from './pipelineNotice';

const base = { complete: false, stale: false };

describe('getPipelineNotice', () => {
  it('shows no notice without status or for a complete organization read', () => {
    expect(getPipelineNotice(undefined)).toBe('none');
    expect(getPipelineNotice({ outcome: 'complete', complete: true, stale: false })).toBe('none');
  });

  it('uses a neutral note when the accessible projects were fully read', () => {
    expect(getPipelineNotice({ ...base, outcome: 'partial', accessibleScopeComplete: true, organizationSnapshotComplete: false })).toBe('accessible');
  });

  it('keeps the warning when pagination or a required query is incomplete', () => {
    expect(getPipelineNotice({ ...base, outcome: 'partial', accessibleScopeComplete: false })).toBe('partial');
    expect(getPipelineNotice({ ...base, outcome: 'partial' })).toBe('partial');
  });

  it('never downgrades failed or stale data to a neutral note', () => {
    expect(getPipelineNotice({ ...base, outcome: 'failed', accessibleScopeComplete: true })).toBe('failed');
    expect(getPipelineNotice({ ...base, outcome: 'partial', stale: true, accessibleScopeComplete: true })).toBe('partial');
    expect(getPipelineNotice({ outcome: 'complete', complete: true, stale: true })).toBe('stale');
  });
});
