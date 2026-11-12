import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@wms3d/ui skeleton', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@wms3d/ui');
  });
});
