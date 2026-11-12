import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Segmented, Space, Spin, Tag } from 'antd';
import type { Occupancy, TwinModel } from '@wms3d/contracts';
import { ApiError, connectEvents } from '@wms3d/api-client';
import {
  createOccupancySync,
  TwinView,
  type CameraPreset,
  type ColorMode,
  type TwinRenderMode,
  type TwinViewHandle,
} from '@wms3d/twin3d';
import { api, getAccessToken, refreshSession } from '../api';
import { errorMessage } from '../lib/errors';

export interface TwinPanelProps {
  warehouseId: string;
  /** 高亮 locationId（SKU / 仓位定位） */
  highlight?: readonly string[];
  /** SSE 实时刷新 occupancy（大屏页开启；定位抽屉可关闭） */
  live?: boolean;
  height?: number | string;
  onPick?: (locationId: string) => void;
  /** TwinModel 加载完成（供上层做 id→code 映射等） */
  onModel?: (m: TwinModel) => void;
  toolbar?: boolean;
}

/**
 * 3D 孪生面板（懒加载块：只有打开 3D 时才下载 three.js）。
 * 数据：GET twin（ETag=layoutVersion）+ GET occupancy；live 时 connectEvents → createOccupancySync（06 §6）。
 */
export default function TwinPanel(props: TwinPanelProps) {
  const { warehouseId, live = false } = props;
  const [model, setModel] = useState<TwinModel | null>(null);
  const [occ, setOcc] = useState<Occupancy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ColorMode>('occupancy');
  const [preset, setPreset] = useState<CameraPreset>('iso');
  const [renderMode, setRenderMode] = useState<TwinRenderMode | null>(null);
  const [sse, setSse] = useState<'off' | 'connecting' | 'open' | 'retrying'>(
    live ? 'connecting' : 'off',
  );
  const ref = useRef<TwinViewHandle>(null);
  const modelRef = useRef<TwinModel | null>(null);
  const onModel = useRef(props.onModel);
  onModel.current = props.onModel;

  const fetchOccupancy = useCallback(
    async (layoutVersion: number) => {
      try {
        return await api.r.getOccupancy({ params: { id: warehouseId }, query: { layoutVersion } });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'LAYOUT_STALE') throw { code: 'LAYOUT_STALE' };
        throw e;
      }
    },
    [warehouseId],
  );

  const loadModel = useCallback(async () => {
    try {
      const m = await api.r.getTwin({ params: { id: warehouseId } });
      if (!m) return;
      modelRef.current = m;
      setModel(m);
      onModel.current?.(m);
      const o = await fetchOccupancy(m.layoutVersion);
      if (o) setOcc(o);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [warehouseId, fetchOccupancy]);

  useEffect(() => {
    modelRef.current = null;
    setModel(null);
    setOcc(null);
    void loadModel();
  }, [loadModel]);

  useEffect(() => {
    if (!live) return;
    const sync = createOccupancySync({
      platform: 'pc',
      getLayoutVersion: () => modelRef.current?.layoutVersion ?? null,
      fetchOccupancy,
      onOccupancy: (o) => setOcc(o),
      reloadTwin: () => void loadModel(),
      onError: (e) => setError(errorMessage(e)),
    });
    const conn = connectEvents({
      warehouseId,
      getAccessToken,
      refresh: refreshSession,
      onEvent: (e) => sync.handleEvent(e),
      onOpen: () => {
        setSse('open');
        sync.onConnected();
      },
      onError: () => {
        setSse('retrying');
        sync.onDisconnected();
      },
    });
    const vis = () => sync.onVisibilityChange();
    document.addEventListener('visibilitychange', vis);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      conn.close();
      sync.dispose();
    };
  }, [live, warehouseId, fetchOccupancy, loadModel]);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: props.height ?? 560 }}
      data-testid="twin-panel"
    >
      {props.toolbar !== false && (
        <Space wrap style={{ marginBottom: 8 }}>
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => setMode(v as ColorMode)}
            options={[
              { value: 'occupancy', label: '占用率' },
              { value: 'skuCount', label: 'SKU 数' },
              { value: 'zone', label: '库区' },
            ]}
          />
          <Segmented
            size="small"
            value={preset}
            onChange={(v) => setPreset(v as CameraPreset)}
            options={[
              { value: 'iso', label: '斜视' },
              { value: 'top', label: '俯视' },
              { value: 'aisle', label: '巷道' },
            ]}
          />
          {model && (
            <Tag>
              布局 v{model.layoutVersion} · {model.locations.id.length} 仓位
            </Tag>
          )}
          {renderMode && (
            <Tag color={renderMode === '3d' ? 'blue' : 'orange'}>
              {renderMode === '3d' ? '3D' : '2D 降级'}
            </Tag>
          )}
          {live && (
            <Tag color={sse === 'open' ? 'green' : 'default'} data-testid="twin-sse">
              {sse === 'open' ? '实时' : sse === 'connecting' ? '连接中' : '重连中（60s 轮询）'}
            </Tag>
          )}
        </Space>
      )}
      {error && <Alert type="error" title={error} style={{ marginBottom: 8 }} />}
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 300,
          background: '#f5f7fa',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {!model && !error && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <Spin />
          </div>
        )}
        <TwinView
          ref={ref}
          model={model}
          occupancy={occ}
          colorMode={mode}
          cameraPreset={preset}
          highlight={props.highlight ?? []}
          onPick={props.onPick}
          onModeChange={(m) => setRenderMode(m)}
          onStaleOccupancy={() => void loadModel()}
          style={{ position: 'absolute', inset: 0 }}
        />
      </div>
    </div>
  );
}
