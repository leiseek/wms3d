import { describe, expect, it } from 'vitest';
import { hostOf, normalizeApi, parseConfigCode } from './config.ts';

const PIN = 'sha256/' + 'A'.repeat(43) + '=';

describe('服务器配置码', () => {
  it('解析 api + pin', () => {
    expect(parseConfigCode(`wms3d://config?api=https://wms.example.com/&pin=${PIN}`)).toEqual({
      api: 'https://wms.example.com',
      pin: PIN,
    });
  });
  it('支持新旧两个指纹（证书轮换）', () => {
    expect(parseConfigCode(`wms3d://config?api=https://h:8443/api/v1&pin=${PIN},${PIN}`)?.api).toBe(
      'https://h:8443',
    );
  });
  it('拒绝非法输入', () => {
    expect(parseConfigCode('https://wms.example.com')).toBeNull();
    expect(parseConfigCode('wms3d://config?api=ftp://x')).toBeNull();
    expect(parseConfigCode('wms3d://config?api=https://x&pin=md5/abc')).toBeNull();
    expect(parseConfigCode('wms3d://config?pin=' + PIN)).toBeNull();
  });
  it('normalizeApi / hostOf', () => {
    expect(normalizeApi('http://10.0.0.5:4000/api/v1/')).toBe('http://10.0.0.5:4000');
    expect(normalizeApi('nonsense')).toBeNull();
    expect(hostOf('https://wms.example.com:8443')).toBe('wms.example.com:8443');
  });
});
