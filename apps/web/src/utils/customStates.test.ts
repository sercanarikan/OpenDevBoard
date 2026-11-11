import { describe, it, expect } from 'vitest';
import i18n from '../i18n';
import { stateLabel } from '../i18n/labels';
import { getWorkItemStateCategory, isWorkItemCompleted } from './workState';
import { getKanbanColumnForState } from './kanbanEngine';

/**
 * Custom Azure DevOps process states (e.g. "Approved", "In Development", "Waiting 4 Pull Request") are shown exactly
 * as Azure DevOps names them. They are never promoted to Done/Resolved: that would need a VERIFIED mapping, and none
 * exists unless the caller provides one explicitly (WorkflowMetadata.customStateMap).
 */
const CUSTOM = ['Approved', 'In Development', 'Waiting for Development', 'Waiting 4 Pull Request', 'In Analysis', 'Weird State'];

describe('custom process states', () => {
  it('are never completed and never "Resolved" without a verified mapping', () => {
    for (const s of CUSTOM) {
      expect(isWorkItemCompleted(s), s).toBe(false);
      expect(getWorkItemStateCategory(s), s).toBe('InProgress');
    }
  });

  it('land safely in the in-progress Kanban column', () => {
    for (const s of CUSTOM) expect(getKanbanColumnForState(s), s).toBe('in-progress');
  });

  it('are promoted only through an explicit, verified customStateMap', () => {
    const meta = { customStateMap: { approved: 'Proposed' as const, 'in development': 'InProgress' as const, signed: 'Completed' as const } };
    expect(getWorkItemStateCategory('Approved', meta)).toBe('Proposed');
    expect(isWorkItemCompleted('Signed', 'Task', { workflowMetadata: meta })).toBe(true);
    // a custom state NOT in the verified map stays safe
    expect(isWorkItemCompleted('Waiting 4 Pull Request', 'Task', { workflowMetadata: meta })).toBe(false);
  });

  it('keep their raw name in both languages (only known states get a localized label)', async () => {
    for (const lng of ['tr', 'en'] as const) {
      await i18n.changeLanguage(lng);
      for (const s of CUSTOM) expect(stateLabel(i18n.t, s), `${lng}:${s}`).toBe(s);
    }
    await i18n.changeLanguage('tr');
    expect(stateLabel(i18n.t, 'Done')).not.toBe('Done'); // known states are localized for display only
    expect(stateLabel(i18n.t, 'Done')).toBe('Tamamlandı');
  });

  it('the raw state value is never modified by display labelling', () => {
    const item = { state: 'Waiting 4 Pull Request' };
    stateLabel(i18n.t, item.state);
    expect(item.state).toBe('Waiting 4 Pull Request');
  });
});
