import type { AppState, Lock, Order } from './types';

export interface Session {
  token: string;
  user: { id: string; role: 'user' | 'staff' };
  expiresAt: number;
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem('ticket-session');
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s.token || s.expiresAt <= Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  if (s) localStorage.setItem('ticket-session', JSON.stringify(s));
  else localStorage.removeItem('ticket-session');
}

async function request<T>(path: string, options: RequestInit = {}, auth = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const s = getSession();
    if (s) headers['Authorization'] = `Bearer ${s.token}`;
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401) saveSession(null); // 会话失效，本地同步清除
    throw Object.assign(new Error(data.error || `请求失败 (${res.status})`), {
      status: res.status,
      conflicts: data.conflicts as string[] | undefined,
    });
  }
  return data as T;
}

export const api = {
  // 公开
  state: () => request<AppState>('/api/state'),
  login: (username: string, password: string) =>
    request<Session>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  // 需要会话（身份取自服务端会话，无需也不允许客户端自报）
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST', body: '{}' }, true),
  myState: () => request<{ locks: Lock[]; orders: Order[] }>('/api/my/state', {}, true),
  createLock: (showId: string, seatIds: string[]) =>
    request<{ lock: Lock }>('/api/locks', { method: 'POST', body: JSON.stringify({ showId, seatIds }) }, true),
  createOrder: (lockId: string, idempotencyKey: string, couponId: string | null) =>
    request<{ order: Order }>('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ lockId, idempotencyKey, couponId }),
    }, true),
  pay: (orderId: string, result: 'success' | 'failure') =>
    request<{ order: Order }>(`/api/orders/${orderId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ result }),
    }, true),
  refund: (orderId: string, seatIds: string[]) =>
    request<{ order: Order; refund: import('./types').Refund }>(
      `/api/orders/${orderId}/refund`,
      { method: 'POST', body: JSON.stringify({ seatIds }) },
      true,
    ),
  // 工作人员
  adminState: () => request<{ locks: Lock[]; orders: Order[] }>('/api/admin/state', {}, true),
  adminRelease: (lockId: string) =>
    request<{ lock: Lock }>(`/api/admin/locks/${lockId}/release`, { method: 'POST', body: '{}' }, true),
};
