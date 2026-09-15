import type { AppState } from './types';

export function getOwner(): string {
  let owner = localStorage.getItem('ticket-owner');
  if (!owner) {
    owner = 'user-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('ticket-owner', owner);
  }
  return owner;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `请求失败 (${res.status})`), {
      status: res.status,
      conflicts: data.conflicts as string[] | undefined,
    });
  }
  return data as T;
}

export const api = {
  state: () => request<AppState>('/api/state'),
  createLock: (showId: string, seatIds: string[], owner: string) =>
    request<{ lock: import('./types').Lock }>('/api/locks', {
      method: 'POST',
      body: JSON.stringify({ showId, seatIds, owner }),
    }),
  createOrder: (lockId: string, owner: string, idempotencyKey: string, couponId: string | null) =>
    request<{ order: import('./types').Order }>('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ lockId, owner, idempotencyKey, couponId }),
    }),
  pay: (orderId: string, result: 'success' | 'failure') =>
    request<{ order: import('./types').Order }>(`/api/orders/${orderId}/pay`, {
      method: 'POST',
      body: JSON.stringify({ result }),
    }),
  refund: (orderId: string, seatIds: string[]) =>
    request<{ order: import('./types').Order; refund: import('./types').Refund }>(
      `/api/orders/${orderId}/refund`,
      { method: 'POST', body: JSON.stringify({ seatIds }) },
    ),
  adminRelease: (lockId: string) =>
    request<{ lock: import('./types').Lock }>(`/api/admin/locks/${lockId}/release`, {
      method: 'POST',
      body: '{}',
    }),
};
