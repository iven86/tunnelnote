import { describe, expect, it } from 'vitest';
import { appInfoSchema, getAppInfoRequestSchema } from '../../src/shared/app-info';

describe('app info IPC schemas', () => {
  it('accepts an empty request and rejects unexpected request properties', () => {
    expect(getAppInfoRequestSchema.parse({})).toEqual({});
    expect(() => getAppInfoRequestSchema.parse({ secret: 'unexpected' })).toThrow();
  });

  it('accepts valid app metadata and rejects malformed responses', () => {
    expect(appInfoSchema.parse({ name: 'TunnelNote', version: '0.1.0' })).toEqual({
      name: 'TunnelNote',
      version: '0.1.0',
    });
    expect(() => appInfoSchema.parse({ name: '', version: '0.1.0' })).toThrow();
  });
});
