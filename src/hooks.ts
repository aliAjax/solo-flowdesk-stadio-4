import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AppState } from './types';

/** 轮询全局状态：每 intervalMs 拉取一次，页面重新聚焦时立即拉取。 */
export function useAppState(intervalMs = 2000) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = window.setInterval(() => void refresh(), intervalMs);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer.current);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, intervalMs]);

  return { state, error, refresh };
}

/** 每秒触发的倒计时（目标时间戳，毫秒）。返回剩余毫秒，不为负。 */
export function useCountdown(targetMs: number | null | undefined, now: number | undefined) {
  if (!targetMs || !now) return 0;
  return Math.max(0, targetMs - now);
}

export function fmtCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtPrice(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

export function seatLabel(s: { area: string; row: number; no: number }): string {
  return `${s.area} ${s.row}排${s.no}座`;
}
