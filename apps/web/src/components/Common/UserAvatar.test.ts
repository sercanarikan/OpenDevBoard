import { describe, it, expect } from 'vitest';
import { UserAvatar } from './UserAvatar';

describe('UserAvatar Component', () => {
  it('is defined and exports a React functional component', () => {
    expect(UserAvatar).toBeDefined();
    expect(typeof UserAvatar).toBe('function');
  });
});
