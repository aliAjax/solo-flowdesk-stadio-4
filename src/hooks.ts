import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getSession, type Session } from './api';
import type { AppState, Lock, Order } from './types';

export interface AppData {
  state: AppState | null;
  mine: { locks: Lock[]; orders: Order[] } | null;
  session: Session | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/** 轮询全局公开状态；登录后同时拉取本人锁座与订单。页面聚焦时立即刷新。 */
export function useAppState(intervalMs = 2000): AppData {
  const [state, setState] = useState<AppState | null>(null);
  const [mine, setMine] = useState<AppData['mine']>(null);
  const [session, setSession] = useState<Session | null>(() => getSession());
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    const s = getSession();
    setSession(s);
    try {
      const pub = await api.state();
      setState(pub);
      if (s) {
        try {
          setMine(await api.myState());
        } catch {
          setMine(null); // 会话失效时公开状态仍可用
        }
      } else {
        setMine(null);
      }
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

  return { state, mine, session, error, refresh };
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
