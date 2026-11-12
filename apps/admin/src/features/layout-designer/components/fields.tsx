import { useEffect, useState } from 'react';
import { Input, InputNumber } from 'antd';

/** 失焦/回车才提交的数字输入（避免每次按键都进撤销栈）。 */
export function NumField(p: {
  value: number;
  onCommit(v: number): void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  testId?: string;
  disabled?: boolean;
  suffix?: string;
}) {
  const [v, setV] = useState<number | null>(p.value);
  useEffect(() => setV(p.value), [p.value]);
  const commit = () => {
    if (v === null || Number.isNaN(v) || v === p.value) return setV(p.value);
    p.onCommit(v);
  };
  return (
    <InputNumber
      size="small"
      style={{ width: '100%' }}
      value={v}
      min={p.min}
      max={p.max}
      step={p.step}
      precision={p.precision}
      disabled={p.disabled}
      suffix={p.suffix}
      onChange={(x) => setV(typeof x === 'number' ? x : null)}
      onBlur={commit}
      onPressEnter={commit}
      data-testid={p.testId}
    />
  );
}

export function TextField(p: {
  value: string;
  onCommit(v: string): void;
  testId?: string;
  maxLength?: number;
  upper?: boolean;
}) {
  const [v, setV] = useState(p.value);
  useEffect(() => setV(p.value), [p.value]);
  const commit = () => (v !== p.value ? p.onCommit(v) : undefined);
  return (
    <Input
      size="small"
      value={v}
      maxLength={p.maxLength}
      onChange={(e) => setV(p.upper ? e.target.value.toUpperCase() : e.target.value)}
      onBlur={commit}
      onPressEnter={commit}
      data-testid={p.testId}
    />
  );
}
