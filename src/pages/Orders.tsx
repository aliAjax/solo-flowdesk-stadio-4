import { useMemo, useState } from 'react';
import { api, getOwner } from '../api';
import { fmtCountdown, fmtPrice, seatLabel, useAppState } from '../hooks';
import { statusText } from './ShowDetail';
import type { Order } from '../types';

export default function Orders() {
  const { state, refresh } = useAppState();
  const owner = useMemo(getOwner, []);
  const [refundSel, setRefundSel] = useState<Record<string, Set<string>>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!state) return <div className="loading">加载中…</div>;
  const myOrders = state.orders
    .filter((o) => o.owner === owner)
    .sort((a, b) => b.createdAt - a.createdAt);

  const toggleRefundSeat = (orderId: string, seatId: string) => {
    setRefundSel((prev) => {
      const next = { ...prev };
      const set = new Set(next[orderId] ?? []);
      if (set.has(seatId)) set.delete(seatId);
      else set.add(seatId);
      next[orderId] = set;
      return next;
    });
  };

  const doRefund = async (order: Order) => {
    const sel = [...(refundSel[order.id] ?? [])];
    if (sel.length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { refund } = await api.refund(order.id, sel);
      setMessage({
        kind: 'ok',
        text: `退款单 ${refund.id} 已生成，共退 ${fmtPrice(refund.total)}（${refund.lines.length} 个座位）`,
      });
      setRefundSel((prev) => ({ ...prev, [order.id]: new Set() }));
    } catch (e) {
      setMessage({ kind: 'err', text: `退款失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div>
      <h1>我的订单</h1>
      {message && (
        <div className={`banner ${message.kind === 'ok' ? 'success' : 'error'}`} data-testid="refund-message">
          {message.text}
        </div>
      )}
      {myOrders.length === 0 && <p className="muted">暂无订单，去「场次购票」选座下单。</p>}
      {myOrders.map((order) => {
        const show = state.shows.find((s) => s.id === order.showId);
        const refundedSeats = new Set(order.refunds.flatMap((r) => r.seatIds));
        const refundable = order.status === 'paid' || order.status === 'partially_refunded';
        const sel = refundSel[order.id] ?? new Set<string>();
        const payRemain = Math.max(0, order.payExpiresAt - state.now);
        return (
          <section key={order.id} className="order-card" data-testid={`order-${order.id}`}>
            <header>
              <b>{order.id}</b> · {show?.name} ·{' '}
              <span className={`status status-${order.status}`} data-testid={`status-${order.id}`}>
                {statusText(order.status)}
              </span>
              {order.status === 'pending_payment' && (
                <span className="countdown" data-testid={`order-countdown-${order.id}`}>
                  {' '}支付剩余 {fmtCountdown(payRemain)}
                </span>
              )}
            </header>
            <table className="items">
              <thead>
                <tr>
                  {refundable && <th>退</th>}
                  <th>座位</th><th>票档</th><th>票价</th><th>分摊优惠</th><th>状态</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => {
                  const refunded = refundedSeats.has(item.seatId);
                  return (
                    <tr key={item.seatId} className={refunded ? 'refunded' : ''}>
                      {refundable && (
                        <td>
                          {!refunded && (
                            <input
                              type="checkbox"
                              data-testid={`refund-check-${item.seatId}`}
                              checked={sel.has(item.seatId)}
                              onChange={() => toggleRefundSeat(order.id, item.seatId)}
                            />
                          )}
                        </td>
                      )}
                      <td>{seatLabel(item)}</td>
                      <td>{item.tier}</td>
                      <td>{fmtPrice(item.price)}</td>
                      <td>-{fmtPrice(order.discountAlloc[item.seatId] ?? 0)}</td>
                      <td>{refunded ? '已退款' : '有效'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="order-total">
              小计 {fmtPrice(order.subtotal)} · 优惠 -{fmtPrice(order.discount)} ·{' '}
              <b>实付 {fmtPrice(order.total)}</b>
            </div>

            {refundable && (
              <button
                className="danger"
                data-testid={`refund-button-${order.id}`}
                disabled={busy || sel.size === 0}
                onClick={() => doRefund(order)}
              >
                申请退款（已选 {sel.size} 座）
              </button>
            )}

            {order.refunds.length > 0 && (
              <div className="refunds" data-testid={`refunds-${order.id}`}>
                <h4>退款明细</h4>
                {order.refunds.map((r) => (
                  <div key={r.id} className="refund-record" data-testid={`refund-${r.id}`}>
                    <b>{r.id}</b> · 合计退 {fmtPrice(r.total)}
                    <table className="items">
                      <thead>
                        <tr><th>座位</th><th>票档</th><th>票价</th><th>分摊优惠</th><th>实退</th></tr>
                      </thead>
                      <tbody>
                        {r.lines.map((l) => (
                          <tr key={l.seatId} data-testid={`refund-line-${l.seatId}`}>
                            <td>{seatLabel(l)}</td>
                            <td>{l.tier}</td>
                            <td>{fmtPrice(l.price)}</td>
                            <td>-{fmtPrice(l.discountShare)}</td>
                            <td>{fmtPrice(l.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
