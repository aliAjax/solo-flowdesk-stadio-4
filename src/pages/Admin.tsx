import { useState } from 'react';
import { api } from '../api';
import { fmtCountdown, fmtPrice, seatLabel, useAppState } from '../hooks';
import { statusText } from './ShowDetail';

export default function Admin() {
  const { state, refresh } = useAppState();
  const [staffId, setStaffId] = useState(
    () => localStorage.getItem('ticket-staff-id') || 'staff-01',
  );
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!state) return <div className="loading">加载中…</div>;

  const activeLocks = state.locks.filter((l) => l.status === 'active');
  const convertedLocks = state.locks.filter((l) => l.status === 'converted');

  const release = async (lockId: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.adminRelease(lockId, staffId);
      setMessage({ kind: 'ok', text: `锁座 ${lockId} 已释放，座位恢复可售` });
    } catch (e) {
      setMessage({ kind: 'err', text: `释放失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const lockOrder = (lockId: string) => state.orders.find((o) => o.lockId === lockId);

  return (
    <div>
      <h1>工作人员台</h1>
      <p className="muted">可释放异常锁座；已支付订单受保护，不可操作。</p>
      <label className="field staff-field">
        工作人员工号（服务端校验角色，普通用户调用将被拒绝）
        <input
          data-testid="staff-id-input"
          value={staffId}
          onChange={(e) => {
            setStaffId(e.target.value);
            localStorage.setItem('ticket-staff-id', e.target.value);
          }}
        />
      </label>
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
