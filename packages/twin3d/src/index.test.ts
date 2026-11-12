import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@wms3d/twin3d skeleton', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@wms3d/twin3d');
  });
});
