import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { applyKey, applyQtyKey, KEYBOARD_ROWS, remainingMs, type Countdown } from './logic.ts';

/** 主按钮 ≥ 56dp、字号 ≥ 18sp（04 UX 规则） */
export function BigButton(props: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'danger' | 'default' | 'success';
  disabled?: boolean;
  testId?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className={`ui-btn ui-btn-${props.kind ?? 'default'}`}
      onClick={props.onClick}
      disabled={props.disabled}
      data-testid={props.testId}
      style={props.style}
    >
      {props.children}
    </button>
  );
}

/** 应用内字母数字键盘（大按键；不依赖系统软键盘） */
export function AppKeyboard(props: {
  value: string;
  onChange: (v: string) => void;
  onOk: () => void;
  maxLen?: number;
  testId?: string;
}) {
  const [lower, setLower] = useState(false);
  const press = (k: string) => {
    if (k === 'OK') return props.onOk();
    const s = applyKey({ value: props.value, lower }, k, props.maxLen);
    setLower(s.lower);
    if (s.value !== props.value) props.onChange(s.value);
  };
  const key = (k: string, label?: string, wide = false) => (
    <button
      key={k}
      type="button"
      className={`ui-key${wide ? ' ui-key-wide' : ''}`}
      data-key={k}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => press(k)}
    >
      {label ?? (lower && k.length === 1 ? k.toLowerCase() : k)}
    </button>
  );
  return (
    <div className="ui-keyboard" data-testid={props.testId ?? 'app-keyboard'}>
      {KEYBOARD_ROWS.map((row, i) => (
        <div className="ui-key-row" key={i}>
          {row.map((k) => key(k))}
        </div>
      ))}
      <div className="ui-key-row">
        {key('SHIFT', lower ? 'abc' : 'ABC', true)}
        {key('#')}
        {key('@')}
        {key('SPACE', '空格', true)}
        {key('BACK', '⌫')}
        {key('CLEAR', '清空')}
        {key('OK', '确定', true)}
      </div>
    </div>
  );
}

/** 数量键盘（作业页坚持“无可编辑焦点”） */
export function QtyPad(props: {
  initial: number;
  onOk: (qty: number) => void;
  onCancel: () => void;
  hint?: string;
}) {
  const [v, setV] = useState(String(props.initial));
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLEAR', '0', 'BACK'];
  return (
    <div className="ui-sheet" data-testid="qty-pad">
      <div className="ui-qty-display" data-testid="qty-display">
        {v || '0'}
      </div>
      {props.hint && <div className="ui-hint">{props.hint}</div>}
      <div className="ui-qty-grid">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            className="ui-key ui-key-big"
            data-key={k}
            onClick={() => setV(applyQtyKey(v, k))}
          >
            {k === 'BACK' ? '⌫' : k === 'CLEAR' ? '清空' : k}
          </button>
        ))}
      </div>
      <div className="ui-row">
        <BigButton onClick={props.onCancel}>取消</BigButton>
        <BigButton
          kind="primary"
          testId="qty-ok"
          disabled={!v || Number(v) <= 0}
          onClick={() => props.onOk(Number(v))}
        >
          确定
        </BigButton>
      </div>
    </div>
  );
}

/** 连续模式倒计时条 */
export function CountdownBar(props: { countdown: Countdown | null; now: number }) {
  if (!props.countdown) return null;
  const left = remainingMs(props.countdown, props.now);
  const pct = (left / props.countdown.durationMs) * 100;
  return (
    <div
      className="ui-countdown"
      data-testid="countdown"
      data-paused={props.countdown.pausedAt !== null}
    >
      <div className="ui-countdown-bar" style={{ width: `${pct}%` }} />
      <span className="ui-countdown-text">
        {props.countdown.pausedAt !== null ? '已暂停' : `${Math.ceil(left / 1000)}s 后自动提交`}
      </span>
    </div>
  );
}

/** 打断式拒绝：红色全屏条，必须点“知道了” */
export function RejectOverlay(props: {
  title: string;
  message: string;
  onAck: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="ui-reject" role="alertdialog" data-testid="reject-overlay">
      <div className="ui-reject-title">{props.title}</div>
      <div className="ui-reject-msg" data-testid="reject-message">
        {props.message}
      </div>
      {props.extra}
      <BigButton kind="default" testId="reject-ack" onClick={props.onAck}>
        知道了
      </BigButton>
    </div>
  );
}

/** 每 tick 毫秒刷新一次的当前时间（倒计时/“x 分钟前”） */
export function useNow(tickMs = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return now;
}

export function StatusChip(props: {
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'idle';
  testId?: string;
}) {
  return (
    <span className={`ui-chip ui-chip-${props.tone}`} data-testid={props.testId}>
      {props.label}
    </span>
  );
}
