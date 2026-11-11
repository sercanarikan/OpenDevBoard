import { describe, expect, it } from 'vitest';
import { CURRENT_USER_NAME, mockFlatItems } from './mockData';

describe('public mock fixture privacy', () => {
  it('uses generic synthetic identities and organization/project references', () => {
    const fixtureText = JSON.stringify(mockFlatItems);
    const syntheticIdentities = new Set(['Sample User', 'Fixture Person F', 'Fixture Person G', 'Fixture Person H', 'Fixture Person I', 'Fixture Person J', '']);

    expect(CURRENT_USER_NAME).toBe('Sample User');
    expect(mockFlatItems.every(item => syntheticIdentities.has(item.assignedTo))).toBe(true);
    expect(fixtureText).not.toMatch(/CoreBanking-Platform|CustomerPortal-Mobile|CloudOps-Infrastructure|PaymentGateway-Service|dev\.azure\.com\/company\//);
    expect(fixtureText).toContain('dev.azure.com/example-org/');
  });

  it('preserves work item IDs and all relation references', () => {
    const ids = new Set(mockFlatItems.map(item => item.id));

    expect(ids.size).toBe(mockFlatItems.length);
    for (const item of mockFlatItems) {
      if (item.parentId != null) expect(ids.has(item.parentId)).toBe(true);
      for (const relation of [
        ...item.relations.predecessors,
        ...item.relations.successors,
        ...item.relations.related,
      ]) {
        expect(ids.has(relation.id)).toBe(true);
      }
    }
  });
});
