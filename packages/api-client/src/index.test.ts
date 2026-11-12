import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@wms3d/api-client skeleton', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@wms3d/api-client');
  });
});
