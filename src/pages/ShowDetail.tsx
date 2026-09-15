import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, getOwner } from '../api';
import { fmtCountdown, fmtPrice, seatLabel, useAppState } from '../hooks';
import type { Seat } from '../types';

export default function ShowDetail() {
  const { showId = '' } = useParams();
  const { state, refresh } = useAppState();
  const owner = useMemo(getOwner, []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [couponId, setCouponId] = useState<string>('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const idemKey = useRef<string | null>(null);
  const submitting = useRef(false);

  // 本地 500ms  ticker，驱动倒计时显示
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);

  const show = state?.shows.find((s) => s.id === showId);
  const seats = useMemo(
    () => (state?.seats ?? []).filter((s) => s.showId === showId),
    [state, showId],
  );
  const myLock = state?.locks.find(
    (l) => l.showId === showId && l.owner === owner && l.status === 'active',
  );
  const myPendingOrder = state?.orders.find(
    (o) => o.showId === showId && o.owner === owner && o.status === 'pending_payment',
  );
  const lastOrder = state?.orders
    .filter((o) => o.showId === showId && o.owner === owner)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  // 锁座消失（超时/被释放）时清理本地选择
  useEffect(() => {
    if (!myLock && selected.size > 0 && !busy) setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myLock?.id]);

  if (!state || !show) return <div className="loading">加载中…</div>;

  const toggleSeat = (seat: Seat) => {
    if (seat.status !== 'available' || myLock || myPendingOrder) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seat.id)) next.delete(seat.id);
      else next.add(seat.id);
      return next;
    });
  };

  const lockSeats = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.createLock(showId, [...selected], owner);
      idemKey.current = crypto.randomUUID();
      setMessage({ kind: 'ok', text: '锁座成功，请在倒计时结束前提交订单' });
      setSelected(new Set());
    } catch (e) {
      const err = e as Error & { conflicts?: string[] };
      setMessage({
        kind: 'err',
        text: `锁座失败：${err.message}${err.conflicts ? `（冲突座位 ${err.conflicts.length} 个）` : ''}`,
      });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const submitOrder = async () => {
    if (!myLock || submitting.current) return;
    submitting.current = true; // 同步闸门：重复点击不会发出第二个请求
    setBusy(true);
    setMessage(null);
    try {
      if (!idemKey.current) idemKey.current = crypto.randomUUID();
      const { order } = await api.createOrder(myLock.id, owner, idemKey.current, couponId || null);
      setMessage({ kind: 'ok', text: `订单 ${order.id} 已创建，请在限时内完成支付` });
    } catch (e) {
      setMessage({ kind: 'err', text: `下单失败：${(e as Error).message}` });
    } finally {
      submitting.current = false;
      setBusy(false);
      await refresh();
    }
  };

  const pay = async (result: 'success' | 'failure') => {
    if (!myPendingOrder || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { order } = await api.pay(myPendingOrder.id, result);
      setMessage(
        result === 'success'
          ? { kind: 'ok', text: `支付成功！订单 ${order.id} 已出票` }
          : { kind: 'err', text: '支付失败：座位与优惠名额已释放' },
      );
      idemKey.current = null;
    } catch (e) {
      setMessage({ kind: 'err', text: `支付操作失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const areas = [...new Set(seats.map((s) => s.area))];
  const lockRemain = myLock ? Math.max(0, myLock.expiresAt - now) : 0;
  const payRemain = myPendingOrder ? Math.max(0, myPendingOrder.payExpiresAt - now) : 0;
  const selectedSeats = seats.filter((s) => selected.has(s.id));
  const selectedTotal = selectedSeats.reduce((sum, s) => sum + s.price, 0);
  const coupon = state.coupons.find((c) => c.id === couponId);

  return (
    <div>
      <h1>{show.name}</h1>
      <p className="muted">{show.venue} · {show.startsAt}</p>

      <div className="legend">
        <span><i className="seat-demo available" /> 可选</span>
        <span><i className="seat-demo selected" /> 已选</span>
        <span><i className="seat-demo locked" /> 锁定中</span>
        <span><i className="seat-demo sold" /> 已售</span>
      </div>

      {message && (
        <div className={`banner ${message.kind === 'ok' ? 'success' : 'error'}`} data-testid="flow-message">
          {message.text}
        </div>
      )}

      <div className="layout">
        <div className="seatmap">
          {areas.map((area) => {
            const areaSeats = seats.filter((s) => s.area === area);
            const rows = [...new Set(areaSeats.map((s) => s.row))].sort((a, b) => a - b);
            const tier = areaSeats[0].tier;
            const left = areaSeats.filter((s) => s.status === 'available').length;
            return (
              <section key={area} className="area">
                <h3>
                  <span className={`tier-dot tier-${tier}`} />
                  {area} · {tier} · {fmtPrice(areaSeats[0].price)}
                  <span className="muted" data-testid={`remaining-${area}`}>（余 {left}）</span>
                </h3>
                {rows.map((row) => (
                  <div key={row} className="seat-row">
                    <span className="row-label">{row}排</span>
                    {areaSeats
                      .filter((s) => s.row === row)
                      .sort((a, b) => a.no - b.no)
                      .map((seat) => {
                        const cls = selected.has(seat.id) ? 'selected' : seat.status;
                        return (
                          <button
                            key={seat.id}
                            data-testid={`seat-${seat.id}`}
                            className={`seat ${cls}`}
                            disabled={seat.status !== 'available' || !!myLock || !!myPendingOrder}
                            title={`${seatLabel(seat)} ${fmtPrice(seat.price)}`}
                            onClick={() => toggleSeat(seat)}
                          >
                            {seat.no}
                          </button>
                        );
                      })}
                  </div>
                ))}
              </section>
            );
          })}
        </div>

        <aside className="panel">
          {!myLock && !myPendingOrder && (
            <div data-testid="select-panel">
              <h3>已选座位（{selected.size}）</h3>
              {selectedSeats.length === 0 && <p className="muted">点击座位图选择座位，可多选。</p>}
              <ul className="pick-list">
                {selectedSeats.map((s) => (
                  <li key={s.id}>{seatLabel(s)} · {s.tier} · {fmtPrice(s.price)}</li>
                ))}
              </ul>
              <div className="total">合计 {fmtPrice(selectedTotal)}</div>
              <button
                className="primary"
                data-testid="lock-button"
                disabled={selected.size === 0 || busy}
                onClick={lockSeats}
              >
                锁定座位
              </button>
            </div>
          )}

          {myLock && !myPendingOrder && (
            <div data-testid="checkout-panel">
              <h3>锁座成功</h3>
              <div className="countdown" data-testid="lock-countdown">
                锁座剩余时间 {fmtCountdown(lockRemain)}
              </div>
              {lockRemain === 0 && <p className="muted">锁座已过期，座位将自动释放。</p>}
              <ul className="pick-list">
                {myLock.seatIds.map((sid) => {
                  const s = seats.find((x) => x.id === sid);
                  return s ? <li key={sid}>{seatLabel(s)} · {s.tier} · {fmtPrice(s.price)}</li> : null;
                })}
              </ul>
              <label className="field">
                优惠券
                <select
                  data-testid="coupon-select"
                  value={couponId}
                  onChange={(e) => setCouponId(e.target.value)}
                >
                  <option value="">不使用</option>
                  {state.coupons.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.used >= c.quota}>
                      {c.title}（剩余名额 {c.quota - c.used}）
                    </option>
                  ))}
                </select>
              </label>
              <div className="total">
                应付 {fmtPrice(
                  myLock.seatIds.reduce((sum, sid) => {
                    const s = seats.find((x) => x.id === sid);
                    return sum + (s ? s.price : 0);
                  }, 0) - (coupon ? coupon.amount : 0),
                )}
                {coupon && <span className="muted">（已减 {fmtPrice(coupon.amount)}）</span>}
              </div>
              <button
                className="primary"
                data-testid="submit-order"
                disabled={busy || lockRemain === 0}
                onClick={submitOrder}
              >
                提交订单
              </button>
            </div>
          )}

          {myPendingOrder && (
            <div data-testid="pay-panel">
              <h3>待支付订单 {myPendingOrder.id}</h3>
              <div className="countdown" data-testid="pay-countdown">
                支付剩余时间 {fmtCountdown(payRemain)}
              </div>
              <ul className="pick-list">
                {myPendingOrder.items.map((i) => (
                  <li key={i.seatId}>{seatLabel(i)} · {i.tier} · {fmtPrice(i.price)}</li>
                ))}
              </ul>
              {myPendingOrder.discount > 0 && (
                <div className="muted">优惠 -{fmtPrice(myPendingOrder.discount)}</div>
              )}
              <div className="total">应付 {fmtPrice(myPendingOrder.total)}</div>
              <div className="pay-actions">
                <button className="primary" data-testid="pay-success" disabled={busy} onClick={() => pay('success')}>
                  模拟支付成功
                </button>
                <button className="danger" data-testid="pay-failure" disabled={busy} onClick={() => pay('failure')}>
                  模拟支付失败
                </button>
              </div>
            </div>
          )}

          {!myLock && !myPendingOrder && lastOrder && lastOrder.status !== 'pending_payment' && (
            <div className="muted" data-testid="last-order">
              最近订单 {lastOrder.id}：{statusText(lastOrder.status)}
              {lastOrder.status === 'paid' || lastOrder.status === 'partially_refunded' ? (
                <>（前往「我的订单」办理退款）</>
              ) : null}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

export function statusText(status: string): string {
  const map: Record<string, string> = {
    pending_payment: '待支付',
    paid: '已支付',
    payment_failed: '支付失败',
    cancelled: '已取消',
    partially_refunded: '部分退款',
    refunded: '已全额退款',
  };
  return map[status] ?? status;
}
