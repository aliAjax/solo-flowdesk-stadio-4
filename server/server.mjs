// 演出票务锁座与分账台 —— 后端服务（零依赖）
// 原子性：Node 单线程，所有变更在同步临界区内完成，请求之间不会交错。
// 持久化：每次变更后写穿到 JSON 文件，重启/刷新后状态一致。
// 身份：登录后签发不可预测的会话令牌（crypto.randomBytes），
//       所有写操作与私有查询的身份一律取自服务端会话，不接受客户端自报。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 4180);
const DB_FILE = process.env.TICKET_DB || path.join(path.dirname(new URL(import.meta.url).pathname), 'data.json');
const LOCK_TTL_MS = Number(process.env.TICKET_LOCK_TTL_MS || 120_000);
const PAY_TTL_MS = Number(process.env.TICKET_PAY_TTL_MS || 180_000);
const SESSION_TTL_MS = Number(process.env.TICKET_SESSION_TTL_MS || 8 * 3600_000);
const ALLOW_RESET = process.env.ALLOW_RESET === '1';

// ---------- 数据种子 ----------
function seed() {
  const shows = [
    { id: 'show-1', name: '星海音乐厅 · 交响之夜', venue: '星海音乐厅', startsAt: '2026-10-01 19:30' },
    { id: 'show-2', name: '话剧《茶馆》经典重现', venue: '城市大剧院', startsAt: '2026-10-03 14:00' },
  ];
  const layout = {
    'show-1': [
      { area: 'A区', tier: 'VIP', price: 68000, rows: 3, cols: 8 },
      { area: 'B区', tier: '甲票', price: 48000, rows: 4, cols: 10 },
      { area: 'C区', tier: '乙票', price: 28000, rows: 4, cols: 12 },
    ],
    'show-2': [
      { area: 'A区', tier: 'VIP', price: 58000, rows: 2, cols: 8 },
      { area: 'B区', tier: '甲票', price: 38000, rows: 3, cols: 10 },
    ],
  };
  const seats = [];
  for (const show of shows) {
    for (const sec of layout[show.id]) {
      for (let r = 1; r <= sec.rows; r++) {
        for (let c = 1; c <= sec.cols; c++) {
          seats.push({
            id: `${show.id}-${sec.area}-${r}-${c}`,
            showId: show.id, area: sec.area, row: r, no: c,
            tier: sec.tier, price: sec.price,
            status: 'available', lockId: null, orderId: null,
          });
        }
      }
    }
  }
  return {
    shows, seats,
    locks: [], orders: [],
    coupons: [
      { id: 'coupon-early', title: '早鸟立减 ¥50', amount: 5000, quota: 10, used: 0 },
      { id: 'coupon-member', title: '会员立减 ¥20', amount: 2000, quota: 100, used: 0 },
    ],
    // 账号与角色（演示环境使用明文口令）
    users: [
      { id: 'alice', password: 'alice123', role: 'user' },
      { id: 'bob', password: 'bob123', role: 'user' },
      { id: 'admin', password: 'admin123', role: 'staff' },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `user${i + 1}`, password: 'pass123', role: 'user',
      })),
    ],
    sessions: [], // {token, userId, role, expiresAt}
    seq: { lock: 1, order: 1, refund: 1 },
  };
}

// ---------- 状态加载 / 持久化 ----------
let db;
function load() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(db.users)) db = seed(); // 旧格式数据文件直接重建
  } catch {
    db = seed();
    persist();
  }
}
function persist() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
load();

const seatById = new Map(db.seats.map(s => [s.id, s]));
function reindex() { seatById.clear(); for (const s of db.seats) seatById.set(s.id, s); }

// ---------- 惰性过期清扫（每次请求前执行） ----------
function sweep(now = Date.now()) {
  let dirty = false;
  for (const lock of db.locks) {
    if (lock.status === 'active' && lock.expiresAt <= now) {
      lock.status = 'expired';
      for (const sid of lock.seatIds) {
        const seat = seatById.get(sid);
        if (seat && seat.status === 'locked' && seat.lockId === lock.id) {
          seat.status = 'available'; seat.lockId = null;
        }
      }
      dirty = true;
    }
  }
  for (const order of db.orders) {
    if (order.status === 'pending_payment' && order.payExpiresAt <= now) {
      releaseOrderHold(order, 'cancelled');
      dirty = true;
    }
  }
  const before = db.sessions.length;
  db.sessions = db.sessions.filter(s => s.expiresAt > now);
  if (db.sessions.length !== before) dirty = true;
  if (dirty) persist();
}

// ---------- 会话 ----------
function newToken() {
  return crypto.randomBytes(24).toString('base64url'); // 不可预测
}

function login({ username, password }) {
  const user = db.users.find(u => u.id === username);
  if (!user || user.password !== password) throw httpError(401, '用户名或密码错误');
  const session = {
    token: newToken(), userId: user.id, role: user.role,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  db.sessions.push(session);
  persist();
  return { token: session.token, user: { id: user.id, role: user.role }, expiresAt: session.expiresAt };
}

function logout(session) {
  db.sessions = db.sessions.filter(s => s.token !== session.token);
  persist();
  return { ok: true };
}

/** 从请求头解析会话；缺失、伪造、过期一律返回 null。 */
function sessionFrom(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(h);
  if (!m) return null;
  const s = db.sessions.find(x => x.token === m[1]);
  if (!s || s.expiresAt <= Date.now()) return null;
  return s;
}

function requireUser(req) {
  const s = sessionFrom(req);
  if (!s) throw httpError(401, '未登录或会话已失效');
  return s;
}

function requireStaff(req) {
  const s = requireUser(req);
  if (s.role !== 'staff') throw httpError(403, '需要工作人员角色');
  return s;
}

// 释放订单占有的座位与优惠名额（支付失败 / 支付超时 / 工作人员释放）
function releaseOrderHold(order, nextStatus) {
  for (const item of order.items) {
    const seat = seatById.get(item.seatId);
    if (seat && seat.status === 'locked' && seat.orderId === order.id) {
      seat.status = 'available'; seat.lockId = null; seat.orderId = null;
    }
  }
  if (order.couponId) {
    const coupon = db.coupons.find(c => c.id === order.couponId);
    if (coupon && coupon.used > 0) coupon.used -= 1;
  }
  order.status = nextStatus;
}

// 按票价占比分摊优惠（最大余数法，单位：分），返回 {seatId: 分摊额}
function allocateDiscount(items, discount) {
  const total = items.reduce((s, i) => s + i.price, 0);
  const alloc = {};
  if (discount <= 0 || total <= 0) { for (const i of items) alloc[i.seatId] = 0; return alloc; }
  const shares = items.map(i => {
    const exact = (discount * i.price) / total;
    return { seatId: i.seatId, floor: Math.floor(exact), frac: exact - Math.floor(exact), price: i.price };
  });
  let remainder = discount - shares.reduce((s, x) => s + x.floor, 0);
  shares.sort((a, b) => b.frac - a.frac || b.price - a.price);
  for (const s of shares) { if (remainder <= 0) break; s.floor += 1; remainder -= 1; }
  for (const s of shares) alloc[s.seatId] = s.floor;
  return alloc;
}

// ---------- 业务操作（全部同步、原子；身份取自会话） ----------
function createLock(session, { showId, seatIds }) {
  const owner = session.userId;
  if (!Array.isArray(seatIds) || seatIds.length === 0) throw httpError(400, '未选择座位');
  // 同一用户、同一座位集合的活跃锁 → 幂等返回（防重复点击）
  const dup = db.locks.find(l => l.status === 'active' && l.owner === owner
    && l.seatIds.length === seatIds.length && l.seatIds.every(s => seatIds.includes(s)));
  if (dup) return { lock: dup, idempotent: true };
  const conflicts = [];
  for (const sid of seatIds) {
    const seat = seatById.get(sid);
    if (!seat || seat.showId !== showId) throw httpError(400, `座位不存在: ${sid}`);
    if (seat.status !== 'available') conflicts.push(sid);
  }
  if (conflicts.length > 0) { // 任一座位不可用 → 整单失败，绝不部分锁定
    throw httpError(409, '部分座位已被占用，整单锁定失败', { conflicts });
  }
  const lock = {
    id: `L${db.seq.lock++}`, showId, seatIds: [...seatIds], owner,
    status: 'active', createdAt: Date.now(), expiresAt: Date.now() + LOCK_TTL_MS,
  };
  for (const sid of seatIds) {
    const seat = seatById.get(sid);
    seat.status = 'locked'; seat.lockId = lock.id;
  }
  db.locks.push(lock);
  persist();
  return { lock, idempotent: false };
}

function createOrder(session, { lockId, idempotencyKey, couponId }) {
  const owner = session.userId;
  if (!idempotencyKey) throw httpError(400, '缺少幂等键');
  // 幂等键按用户隔离：仅命中本人的历史订单，不会返回他人订单
  const existed = db.orders.find(o => o.idempotencyKey === idempotencyKey && o.owner === owner);
  if (existed) return { order: existed, idempotent: true };
  const lock = db.locks.find(l => l.id === lockId);
  if (!lock) throw httpError(404, '锁座记录不存在');
  if (lock.owner !== owner) throw httpError(403, '无权操作他人的锁座');
  // 同一锁已建单 → 返回原订单（双保险）
  const byLock = db.orders.find(o => o.lockId === lockId && o.status !== 'cancelled');
  if (byLock) return { order: byLock, idempotent: true };
  if (lock.status !== 'active') throw httpError(409, lock.status === 'expired' ? '锁座已超时释放，请重新选座' : '锁座已失效');
  // 原子校验：全部座位必须仍被该锁持有
  const bad = lock.seatIds.filter(sid => {
    const seat = seatById.get(sid);
    return !seat || seat.status !== 'locked' || seat.lockId !== lockId;
  });
  if (bad.length > 0) throw httpError(409, '座位状态已变化，整单失败', { conflicts: bad });

  let coupon = null;
  if (couponId) {
    coupon = db.coupons.find(c => c.id === couponId);
    if (!coupon) throw httpError(400, '优惠券不存在');
    if (coupon.used >= coupon.quota) throw httpError(409, '优惠名额已用完');
    coupon.used += 1; // 预留优惠名额
  }
  const items = lock.seatIds.map(sid => {
    const s = seatById.get(sid);
    return { seatId: sid, area: s.area, row: s.row, no: s.no, tier: s.tier, price: s.price };
  });
  const subtotal = items.reduce((s, i) => s + i.price, 0);
  const discount = coupon ? Math.min(coupon.amount, subtotal) : 0;
  const order = {
    id: `O${String(db.seq.order++).padStart(4, '0')}`,
    showId: lock.showId, lockId, owner, idempotencyKey,
    items, couponId: coupon ? coupon.id : null,
    subtotal, discount, discountAlloc: allocateDiscount(items, discount),
    total: subtotal - discount,
    status: 'pending_payment',
    refunds: [], createdAt: Date.now(), payExpiresAt: Date.now() + PAY_TTL_MS,
  };
  lock.status = 'converted';
  for (const sid of lock.seatIds) seatById.get(sid).orderId = order.id;
  db.orders.push(order);
  persist();
  return { order, idempotent: false };
}

function payOrder(session, orderId, result) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) throw httpError(404, '订单不存在');
  if (order.owner !== session.userId) throw httpError(403, '无权支付他人的订单');
  if (order.status !== 'pending_payment') throw httpError(409, `订单当前状态不可支付: ${order.status}`);
  if (result === 'success') {
    for (const item of order.items) {
      const seat = seatById.get(item.seatId);
      seat.status = 'sold';
    }
    order.status = 'paid';
    order.paidAt = Date.now();
  } else {
    // 支付失败：释放座位 + 释放优惠名额
    releaseOrderHold(order, 'payment_failed');
  }
  persist();
  return { order };
}

function refundOrder(session, orderId, seatIds) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) throw httpError(404, '订单不存在');
  if (order.owner !== session.userId) throw httpError(403, '无权退款他人的订单');
  if (order.status !== 'paid' && order.status !== 'partially_refunded') {
    throw httpError(409, '仅已支付订单可退款');
  }
  const alreadyRefunded = new Set(order.refunds.flatMap(r => r.seatIds));
  const targets = order.items.filter(i => seatIds.includes(i.seatId));
  if (targets.length === 0) throw httpError(400, '未选择可退座位');
  for (const t of targets) {
    if (alreadyRefunded.has(t.seatId)) throw httpError(409, `座位 ${t.seatId} 已退过款`);
  }
  // 按票档分摊：每座退款额 = 票价 - 该座分摊的优惠
  const lines = targets.map(t => ({
    seatId: t.seatId, area: t.area, row: t.row, no: t.no, tier: t.tier,
    price: t.price, discountShare: order.discountAlloc[t.seatId] || 0,
    amount: t.price - (order.discountAlloc[t.seatId] || 0),
  }));
  const refund = {
    id: `R${db.seq.refund++}`, seatIds: targets.map(t => t.seatId),
    lines, total: lines.reduce((s, l) => s + l.amount, 0), createdAt: Date.now(),
  };
  for (const t of targets) {
    const seat = seatById.get(t.seatId);
    seat.status = 'available'; seat.lockId = null; seat.orderId = null;
  }
  order.refunds.push(refund);
  const refundedCount = order.refunds.reduce((s, r) => s + r.seatIds.length, 0);
  order.status = refundedCount >= order.items.length ? 'refunded' : 'partially_refunded';
  persist();
  return { order, refund };
}

function adminReleaseLock(session, lockId) {
  const lock = db.locks.find(l => l.id === lockId);
  if (!lock) throw httpError(404, '锁座记录不存在');
  if (lock.status === 'active') {
    lock.status = 'released';
    for (const sid of lock.seatIds) {
      const seat = seatById.get(sid);
      if (seat.status === 'locked' && seat.lockId === lock.id) {
        seat.status = 'available'; seat.lockId = null;
      }
    }
    persist();
    return { lock };
  }
  if (lock.status === 'converted') {
    const order = db.orders.find(o => o.lockId === lockId);
    if (order && (order.status === 'paid' || order.status === 'partially_refunded' || order.status === 'refunded')) {
      throw httpError(409, '该锁座已转为已支付订单，工作人员不可操作');
    }
    if (order && order.status === 'pending_payment') {
      releaseOrderHold(order, 'cancelled');
      persist();
      return { lock, order };
    }
    throw httpError(409, '该锁座关联订单已关闭，无需释放');
  }
  throw httpError(409, `锁座已处于 ${lock.status} 状态`);
}

// ---------- HTTP 层 ----------
function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

/** 公开状态：不含任何订单、锁座归属等身份信息。 */
function publicView() {
  return {
    now: Date.now(),
    shows: db.shows,
    seats: db.seats.map(s => ({
      id: s.id, showId: s.showId, area: s.area, row: s.row, no: s.no,
      tier: s.tier, price: s.price, status: s.status,
    })),
    coupons: db.coupons,
    lockTtlMs: LOCK_TTL_MS,
    payTtlMs: PAY_TTL_MS,
  };
}

/** 本人私有状态：仅当前会话用户的锁座与订单。 */
function myView(session) {
  return {
    locks: db.locks.filter(l => l.owner === session.userId),
    orders: db.orders.filter(o => o.owner === session.userId),
  };
}

/** 工作人员视图：全量锁座与订单。 */
function adminView() {
  return { locks: db.locks, orders: db.orders };
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try {
      sweep();
      const url = new URL(req.url, 'http://x');
      const payload = body ? JSON.parse(body) : {};
      const out = route(req, req.method, url, payload);
      res.statusCode = 200;
      res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = e.status || 500;
      res.end(JSON.stringify({ error: e.message, ...(e.extra || {}) }));
    }
  });
});

function route(req, method, url, payload) {
  const p = url.pathname;

  // 公开
  if (method === 'GET' && p === '/api/state') return publicView();
  if (method === 'POST' && p === '/api/login') return login(payload);

  // 需要登录
  if (method === 'POST' && p === '/api/logout') return logout(requireUser(req));
  if (method === 'GET' && p === '/api/my/state') return myView(requireUser(req));
  if (method === 'POST' && p === '/api/locks') return createLock(requireUser(req), payload);
  if (method === 'POST' && p === '/api/orders') return createOrder(requireUser(req), payload);
  const pay = p.match(/^\/api\/orders\/([\w-]+)\/pay$/);
  if (method === 'POST' && pay) return payOrder(requireUser(req), pay[1], payload.result);
  const refund = p.match(/^\/api\/orders\/([\w-]+)\/refund$/);
  if (method === 'POST' && refund) return refundOrder(requireUser(req), refund[1], payload.seatIds || []);

  // 需要工作人员角色（角色取自服务端会话，客户端自报字段无效）
  if (method === 'GET' && p === '/api/admin/state') return adminView(requireStaff(req));
  const rel = p.match(/^\/api\/admin\/locks\/([\w-]+)\/release$/);
  if (method === 'POST' && rel) return adminReleaseLock(requireStaff(req), rel[1]);

  // 测试钩子
  if (ALLOW_RESET && method === 'POST' && p === '/api/__reset') {
    db = seed(); reindex(); persist();
    return { ok: true };
  }
  if (ALLOW_RESET && method === 'POST' && p === '/api/__expire') {
    const s = db.sessions.find(x => x.token === payload.token);
    if (s) { s.expiresAt = 0; persist(); }
    return { ok: true };
  }
  throw httpError(404, 'Not Found');
}

server.listen(PORT, () => {
  console.log(`ticket server on http://127.0.0.1:${PORT} (lockTtl=${LOCK_TTL_MS}ms payTtl=${PAY_TTL_MS}ms sessionTtl=${SESSION_TTL_MS}ms db=${DB_FILE})`);
});
