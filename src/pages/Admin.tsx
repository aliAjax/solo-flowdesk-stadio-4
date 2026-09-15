import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtCountdown, fmtPrice, seatLabel, useAppState } from '../hooks';
import { statusText } from './ShowDetail';
import type { Lock, Order } from '../types';

export default function Admin() {
  const { state, session, refresh } = useAppState();
  const [adminData, setAdminData] = useState<{ locks: Lock[]; orders: Order[] } | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAdmin = useCallback(async () => {
    if (!session || session.user.role !== 'staff') {
      setAdminData(null);
      setForbidden(!!session);
      return;
    }
    try {
      setAdminData(await api.adminState());
      setForbidden(false);
    } catch {
      setAdminData(null);
      setForbidden(true);
    }
  }, [session]);

  useEffect(() => {
    void loadAdmin();
    const t = window.setInterval(() => void loadAdmin(), 2000);
    return () => window.clearInterval(t);
  }, [loadAdmin]);

  if (!state) return <div className="loading">加载中…</div>;
  if (!session) {
    return (
      <div>
        <h1>工作人员台</h1>
        <p className="muted" data-testid="login-required">
          请先以工作人员账号 <Link to="/login">登录</Link>。
        </p>
      </div>
    );
  }
  if (forbidden) {
    return (
      <div>
        <h1>工作人员台</h1>
        <div className="banner error" data-testid="forbidden">
          当前账号 {session.user.id} 不是工作人员，无权访问。
        </div>
      </div>
    );
  }
  if (!adminData) return <div className="loading">加载中…</div>;

  const activeLocks = adminData.locks.filter((l) => l.status === 'active');
  const convertedLocks = adminData.locks.filter((l) => l.status === 'converted');

  const release = async (lockId: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.adminRelease(lockId);
      setMessage({ kind: 'ok', text: `锁座 ${lockId} 已释放，座位恢复可售` });
    } catch (e) {
      setMessage({ kind: 'err', text: `释放失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
      await Promise.all([refresh(), loadAdmin()]);
    }
  };

  const lockOrder = (lockId: string) => adminData.orders.find((o) => o.lockId === lockId);

  return (
    <div>
      <h1>工作人员台</h1>
      <p className="muted">
        当前工作人员：{session.user.id}。可释放异常锁座；已支付订单受保护，不可操作。
      </p>
      {message && (
        <div className={`banner ${message.kind === 'ok' ? 'success' : 'error'}`} data-testid="admin-message">
          {message.text}
        </div>
      )}

      <h2>活跃锁座（{activeLocks.length}）</h2>
      {activeLocks.length === 0 && <p className="muted">当前没有活跃锁座。</p>}
      {activeLocks.map((lock) => {
        const remain = Math.max(0, lock.expiresAt - state.now);
        return (
          <div key={lock.id} className="lock-row" data-testid={`admin-lock-${lock.id}`}>
            <span>
              <b>{lock.id}</b> · {lock.owner} · {lock.seatIds.length} 座（
              {lock.seatIds
                .map((sid) => {
                  const s = state.seats.find((x) => x.id === sid);
                  return s ? seatLabel(s) : sid;
                })
                .join('、')}
              ）
            </span>
            <span className="countdown" data-testid={`admin-lock-countdown-${lock.id}`}>
              剩余 {fmtCountdown(remain)}
            </span>
            <button className="danger" data-testid={`release-${lock.id}`} disabled={busy} onClick={() => release(lock.id)}>
              释放锁座
            </button>
          </div>
        );
      })}

      <h2>已转订单的锁座（{convertedLocks.length}）</h2>
      {convertedLocks.map((lock) => {
        const order = lockOrder(lock.id);
        const paidLike =
          order && (order.status === 'paid' || order.status === 'partially_refunded' || order.status === 'refunded');
        return (
          <div key={lock.id} className="lock-row" data-testid={`admin-lock-${lock.id}`}>
            <span>
              <b>{lock.id}</b> → 订单 {order?.id ?? '-'} ·{' '}
              <span className={`status status-${order?.status}`}>{statusText(order?.status ?? '-')}</span>
              {order && <> · 实付 {fmtPrice(order.total)}</>}
            </span>
            {paidLike ? (
              <span className="muted" data-testid={`protected-${lock.id}`}>已支付订单，不可操作</span>
            ) : (
              <button className="danger" data-testid={`release-${lock.id}`} disabled={busy} onClick={() => release(lock.id)}>
                释放并取消订单
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
