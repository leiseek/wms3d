import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@wms3d/labels skeleton', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@wms3d/labels');
  });
});
