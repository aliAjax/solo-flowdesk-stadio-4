import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const API = 'http://127.0.0.1:4180';

async function reset(request: APIRequestContext) {
  const res = await request.post(`${API}/api/__reset`);
  expect(res.ok()).toBeTruthy();
}

async function publicState(request: APIRequestContext) {
  const res = await request.get(`${API}/api/state`);
  return res.json();
}

async function loginApi(request: APIRequestContext, username: string, password: string) {
  const res = await request.post(`${API}/api/login`, { data: { username, password } });
  expect(res.ok()).toBeTruthy();
  return res.json(); // {token, user, expiresAt}
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** 通过 API 登录并把会话注入页面 localStorage。 */
async function loginPage(page: Page, request: APIRequestContext, username: string, password: string) {
  const session = await loginApi(request, username, password);
  await page.addInitScript((s) => localStorage.setItem('ticket-session', s), JSON.stringify(session));
  return session;
}

async function lockSeatsViaUI(page: Page, seatIds: string[]) {
  for (const id of seatIds) await page.getByTestId(`seat-${id}`).click();
  await page.getByTestId('lock-button').click();
  await expect(page.getByTestId('checkout-panel')).toBeVisible();
}

/** 通过 API 为指定会话锁座并下单，返回订单。 */
async function createOrderApi(
  request: APIRequestContext,
  token: string,
  seatId: string,
  idempotencyKey: string,
) {
  const lockRes = await request.post(`${API}/api/locks`, {
    headers: auth(token),
    data: { showId: 'show-1', seatIds: [seatId] },
  });
  expect(lockRes.ok()).toBeTruthy();
  const { lock } = await lockRes.json();
  const orderRes = await request.post(`${API}/api/orders`, {
    headers: auth(token),
    data: { lockId: lock.id, idempotencyKey },
  });
  expect(orderRes.ok()).toBeTruthy();
  return (await orderRes.json()).order;
}

async function myState(request: APIRequestContext, token: string) {
  const res = await request.get(`${API}/api/my/state`, { headers: auth(token) });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function adminState(request: APIRequestContext, token: string) {
  const res = await request.get(`${API}/api/admin/state`, { headers: auth(token) });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test('场次按区域、排号和票档展示余票', async ({ page }) => {
  await page.goto('/shows');
  await expect(page.getByTestId('remaining-show-1-VIP')).toContainText('余票 24/24');
  await expect(page.getByTestId('remaining-show-1-甲票')).toContainText('余票 40/40');
  await expect(page.getByTestId('remaining-show-1-乙票')).toContainText('余票 48/48');

  await page.getByTestId('show-show-1').click();
  await expect(page.getByTestId('remaining-A区')).toContainText('余 24');
  await expect(page.getByTestId('remaining-B区')).toContainText('余 40');
  await expect(page.getByTestId('remaining-C区')).toContainText('余 48');
  await expect(page.getByTestId('seat-show-1-A区-1-1')).toBeVisible();
  await expect(page.getByTestId('seat-show-1-A区-3-8')).toBeVisible();
  await expect(page.getByTestId('seat-show-1-C区-4-12')).toBeVisible();
});

test('两个标签页同时抢同一座位，最多一个成功', async ({ browser, request }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await loginPage(pageA, request, 'alice', 'alice123');
  await loginPage(pageB, request, 'bob', 'bob123');
  const seat = 'show-1-A区-1-1';

  await pageA.goto('/shows/show-1');
  await pageB.goto('/shows/show-1');
  await pageA.getByTestId(`seat-${seat}`).click();
  await pageB.getByTestId(`seat-${seat}`).click();

  await Promise.all([
    pageA.getByTestId('lock-button').click(),
    pageB.getByTestId('lock-button').click(),
  ]);

  await expect(pageA.getByTestId('flow-message')).toBeVisible();
  await expect(pageB.getByTestId('flow-message')).toBeVisible();
  const textA = await pageA.getByTestId('flow-message').innerText();
  const textB = await pageB.getByTestId('flow-message').innerText();
  const results = [textA, textB];
  expect(results.filter((t) => t.includes('锁座成功')).length).toBe(1);
  expect(results.filter((t) => t.includes('锁座失败')).length).toBe(1);

  // 服务端只有一条活跃锁（通过工作人员视图确认）
  const admin = await loginApi(request, 'admin', 'admin123');
  const s = await adminState(request, admin.token);
  const activeLocks = s.locks.filter((l: any) => l.status === 'active' && l.seatIds.includes(seat));
  expect(activeLocks.length).toBe(1);

  await ctxA.close();
  await ctxB.close();
});

test('高并发 API 抢同一座位，10 个请求仅 1 个成功', async ({ request }) => {
  const seat = 'show-1-A区-1-2';
  // 10 个不同账号的会话
  const sessions = await Promise.all(
    Array.from({ length: 10 }, (_, i) => loginApi(request, `user${i + 1}`, 'pass123')),
  );
  const results = await Promise.all(
    sessions.map((s) =>
      request.post(`${API}/api/locks`, {
        headers: auth(s.token),
        data: { showId: 'show-1', seatIds: [seat] },
      }),
    ),
  );
  const ok = results.filter((r) => r.ok());
  const conflict = results.filter((r) => r.status() === 409);
  expect(ok.length).toBe(1);
  expect(conflict.length).toBe(9);
});

test('重复点击提交不会重复建单', async ({ page, request }) => {
  const alice = await loginPage(page, request, 'alice', 'alice123');
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-A区-1-1', 'show-1-A区-1-2']);

  await page.getByTestId('submit-order').dblclick();
  await expect(page.getByTestId('pay-panel')).toBeVisible();

  const mine = await myState(request, alice.token);
  expect(mine.orders.length).toBe(1);
  expect(mine.orders[0].items.length).toBe(2);
  expect(mine.orders[0].status).toBe('pending_payment');
});

test('支付失败释放座位和优惠名额', async ({ page, request }) => {
  const alice = await loginPage(page, request, 'alice', 'alice123');
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-A区-1-1']);

  await page.getByTestId('coupon-select').selectOption('coupon-early');
  await page.getByTestId('submit-order').click();
  await expect(page.getByTestId('pay-panel')).toBeVisible();

  let s = await publicState(request);
  expect(s.coupons.find((c: any) => c.id === 'coupon-early').used).toBe(1);

  await page.getByTestId('pay-failure').click();
  await expect(page.getByTestId('flow-message')).toContainText('支付失败');

  await expect(page.getByTestId('seat-show-1-A区-1-1')).toBeEnabled();
  s = await publicState(request);
  expect(s.coupons.find((c: any) => c.id === 'coupon-early').used).toBe(0);
  expect(s.seats.find((x: any) => x.id === 'show-1-A区-1-1').status).toBe('available');

  const mine = await myState(request, alice.token);
  expect(mine.orders[0].status).toBe('payment_failed');

  await page.goto('/orders');
  await expect(page.getByTestId(`status-${mine.orders[0].id}`)).toContainText('支付失败');
});

test('锁座超时自动释放并显示剩余时间', async ({ page, request }) => {
  const alice = await loginPage(page, request, 'alice', 'alice123');
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-B区-1-1']);

  const countdown = page.getByTestId('lock-countdown');
  await expect(countdown).toContainText('锁座剩余时间');
  await expect(countdown).toContainText(/0:0[1-4]/);

  await expect(page.getByTestId('checkout-panel')).toBeHidden({ timeout: 15000 });
  await expect(page.getByTestId('select-panel')).toBeVisible();
  await expect(page.getByTestId('seat-show-1-B区-1-1')).toBeEnabled();

  const mine = await myState(request, alice.token);
  expect(mine.locks[0].status).toBe('expired');
  const s = await publicState(request);
  expect(s.seats.find((x: any) => x.id === 'show-1-B区-1-1').status).toBe('available');
});

test('部分退款按票档分摊并列出明细', async ({ page, request }) => {
  const alice = await loginPage(page, request, 'alice', 'alice123');
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-A区-1-1', 'show-1-B区-1-1', 'show-1-C区-1-1']);
  await page.getByTestId('coupon-select').selectOption('coupon-early');
  await page.getByTestId('submit-order').click();
  await expect(page.getByTestId('pay-panel')).toBeVisible();
  await page.getByTestId('pay-success').click();
  await expect(page.getByTestId('flow-message')).toContainText('支付成功');

  await page.goto('/orders');
  const mine0 = await myState(request, alice.token);
  const orderId = mine0.orders[0].id;
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('已支付');

  await page.getByTestId('refund-check-show-1-A区-1-1').check();
  await page.getByTestId('refund-check-show-1-C区-1-1').check();
  await page.getByTestId(`refund-button-${orderId}`).click();

  // 分摊：¥50 按票价占比 → VIP 摊 ¥23.61、甲票 ¥16.67、乙票 ¥9.72
  await expect(page.getByTestId('refund-message')).toContainText('共退 ¥926.67');
  const mine1 = await myState(request, alice.token);
  const refundId = mine1.orders[0].refunds[0].id;
  const detail = page.getByTestId(`refund-${refundId}`);
  await expect(detail).toContainText('VIP');
  await expect(detail).toContainText('¥656.39');
  await expect(detail).toContainText('乙票');
  await expect(detail).toContainText('¥270.28');
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('部分退款');

  const s1 = await publicState(request);
  expect(s1.seats.find((x: any) => x.id === 'show-1-A区-1-1').status).toBe('available');
  expect(s1.seats.find((x: any) => x.id === 'show-1-C区-1-1').status).toBe('available');
  expect(s1.seats.find((x: any) => x.id === 'show-1-B区-1-1').status).toBe('sold');

  await page.getByTestId('refund-check-show-1-B区-1-1').check();
  await page.getByTestId(`refund-button-${orderId}`).click();
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('已全额退款');
});

test('工作人员可释放异常锁座，但不能操作已支付订单', async ({ browser, request }) => {
  // alice 锁座后离开
  const ctxUser = await browser.newContext();
  const pageUser = await ctxUser.newPage();
  await loginPage(pageUser, request, 'alice', 'alice123');
  await pageUser.goto('/shows/show-1');
  await lockSeatsViaUI(pageUser, ['show-1-C区-2-3']);

  // admin 登录工作人员台
  const ctxAdmin = await browser.newContext();
  const pageAdmin = await ctxAdmin.newPage();
  const admin = await loginPage(pageAdmin, request, 'admin', 'admin123');
  await pageAdmin.goto('/admin');

  let s = await adminState(request, admin.token);
  const lockId = s.locks[0].id;
  await expect(pageAdmin.getByTestId(`admin-lock-${lockId}`)).toBeVisible();
  await pageAdmin.getByTestId(`release-${lockId}`).click();
  await expect(pageAdmin.getByTestId('admin-message')).toContainText('已释放');

  s = await adminState(request, admin.token);
  expect(s.locks[0].status).toBe('released');
  const pub = await publicState(request);
  expect(pub.seats.find((x: any) => x.id === 'show-1-C区-2-3').status).toBe('available');

  // alice 完成支付
  await pageUser.goto('/shows/show-1');
  await lockSeatsViaUI(pageUser, ['show-1-C区-2-4']);
  await pageUser.getByTestId('submit-order').click();
  await pageUser.getByTestId('pay-success').click();
  await expect(pageUser.getByTestId('flow-message')).toContainText('支付成功');

  // 工作人员界面：已支付订单不可操作
  await pageAdmin.goto('/admin');
  s = await adminState(request, admin.token);
  const paidLock = s.locks.find((l: any) => l.status === 'converted');
  await expect(pageAdmin.getByTestId(`protected-${paidLock.id}`)).toContainText('已支付订单，不可操作');
  await expect(pageAdmin.getByTestId(`release-${paidLock.id}`)).toHaveCount(0);

  // API 层：工作人员释放已支付订单 → 409
  const resStaff = await request.post(`${API}/api/admin/locks/${paidLock.id}/release`, {
    headers: auth(admin.token),
  });
  expect(resStaff.status()).toBe(409);

  await ctxUser.close();
  await ctxAdmin.close();
});

test('刷新后座位、订单和退款状态一致', async ({ page, request }) => {
  const alice = await loginPage(page, request, 'alice', 'alice123');
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-A区-2-1', 'show-1-A区-2-2']);

  await page.reload();
  await expect(page.getByTestId('checkout-panel')).toBeVisible();
  await expect(page.getByTestId('lock-countdown')).toContainText('锁座剩余时间');
  await expect(page.getByTestId('seat-show-1-A区-2-1')).toHaveClass(/locked/);

  await page.getByTestId('submit-order').click();
  await page.getByTestId('pay-success').click();
  await expect(page.getByTestId('flow-message')).toContainText('支付成功');
  await page.reload();
  await page.goto('/orders');
  const mine0 = await myState(request, alice.token);
  const orderId = mine0.orders[0].id;
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('已支付');

  await page.getByTestId('refund-check-show-1-A区-2-1').check();
  await page.getByTestId(`refund-button-${orderId}`).click();
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('部分退款');
  await page.reload();
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('部分退款');
  const mine1 = await myState(request, alice.token);
  await expect(page.getByTestId(`refund-${mine1.orders[0].refunds[0].id}`)).toBeVisible();
  await expect(page.getByTestId('refund-line-show-1-A区-2-1')).toBeVisible();
});

test('跨用户支付被拒绝且订单状态不变', async ({ request }) => {
  const alice = await loginApi(request, 'alice', 'alice123');
  const bob = await loginApi(request, 'bob', 'bob123');
  const order = await createOrderApi(request, alice.token, 'show-1-A区-1-1', 'key-pay-1');

  const res = await request.post(`${API}/api/orders/${order.id}/pay`, {
    headers: auth(bob.token),
    data: { result: 'success' },
  });
  expect(res.status()).toBe(403);

  let mine = await myState(request, alice.token);
  expect(mine.orders[0].status).toBe('pending_payment');
  const pub = await publicState(request);
  expect(pub.seats.find((x: any) => x.id === 'show-1-A区-1-1').status).toBe('locked');

  const ok = await request.post(`${API}/api/orders/${order.id}/pay`, {
    headers: auth(alice.token),
    data: { result: 'success' },
  });
  expect(ok.ok()).toBeTruthy();
  mine = await myState(request, alice.token);
  expect(mine.orders[0].status).toBe('paid');
});

test('跨用户退款被拒绝且订单状态不变', async ({ request }) => {
  const alice = await loginApi(request, 'alice', 'alice123');
  const bob = await loginApi(request, 'bob', 'bob123');
  const order = await createOrderApi(request, alice.token, 'show-1-A区-1-1', 'key-refund-1');
  await request.post(`${API}/api/orders/${order.id}/pay`, {
    headers: auth(alice.token),
    data: { result: 'success' },
  });

  const res = await request.post(`${API}/api/orders/${order.id}/refund`, {
    headers: auth(bob.token),
    data: { seatIds: ['show-1-A区-1-1'] },
  });
  expect(res.status()).toBe(403);

  let mine = await myState(request, alice.token);
  expect(mine.orders[0].status).toBe('paid');
  expect(mine.orders[0].refunds.length).toBe(0);
  const pub = await publicState(request);
  expect(pub.seats.find((x: any) => x.id === 'show-1-A区-1-1').status).toBe('sold');

  const ok = await request.post(`${API}/api/orders/${order.id}/refund`, {
    headers: auth(alice.token),
    data: { seatIds: ['show-1-A区-1-1'] },
  });
  expect(ok.ok()).toBeTruthy();
  mine = await myState(request, alice.token);
  expect(mine.orders[0].status).toBe('refunded');
});

test('幂等键按用户隔离，冲突时不返回他人订单', async ({ request }) => {
  const alice = await loginApi(request, 'alice', 'alice123');
  const bob = await loginApi(request, 'bob', 'bob123');
  const KEY = 'shared-key-1';
  const orderA = await createOrderApi(request, alice.token, 'show-1-A区-1-1', KEY);
  const orderB = await createOrderApi(request, bob.token, 'show-1-A区-1-2', KEY);
  expect(orderB.id).not.toBe(orderA.id);
  expect(orderB.owner).toBe('bob');

  const dup = await request.post(`${API}/api/orders`, {
    headers: auth(alice.token),
    data: { lockId: 'whatever', idempotencyKey: KEY },
  });
  const dupBody = await dup.json();
  expect(dupBody.order.id).toBe(orderA.id);
  expect(dupBody.idempotent).toBe(true);

  const admin = await loginApi(request, 'admin', 'admin123');
  const s = await adminState(request, admin.token);
  expect(s.orders.length).toBe(2);
});

test('未登录访问受保护接口一律拒绝', async ({ request }) => {
  // 公开接口可用
  const pub = await request.get(`${API}/api/state`);
  expect(pub.ok()).toBeTruthy();

  for (const call of [
    () => request.get(`${API}/api/my/state`),
    () => request.post(`${API}/api/locks`, { data: { showId: 'show-1', seatIds: ['show-1-A区-1-1'] } }),
    () => request.post(`${API}/api/orders`, { data: { lockId: 'L1', idempotencyKey: 'k' } }),
    () => request.post(`${API}/api/orders/O0001/pay`, { data: { result: 'success' } }),
    () => request.post(`${API}/api/orders/O0001/refund`, { data: { seatIds: [] } }),
    () => request.get(`${API}/api/admin/state`),
    () => request.post(`${API}/api/admin/locks/L1/release`),
  ]) {
    const res = await call();
    expect(res.status()).toBe(401);
  }
});

test('伪造会话令牌被拒绝', async ({ request }) => {
  const forged = 'forged-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let res = await request.get(`${API}/api/my/state`, { headers: auth(forged) });
  expect(res.status()).toBe(401);
  res = await request.post(`${API}/api/locks`, {
    headers: auth(forged),
    data: { showId: 'show-1', seatIds: ['show-1-A区-1-1'] },
  });
  expect(res.status()).toBe(401);
  res = await request.get(`${API}/api/admin/state`, { headers: auth(forged) });
  expect(res.status()).toBe(401);
});

test('普通账号冒用工作人员接口被拒绝，伪造工号字段无效', async ({ request }) => {
  const alice = await loginApi(request, 'alice', 'alice123');
  const admin = await loginApi(request, 'admin', 'admin123');

  // alice 锁一个座位
  const lockRes = await request.post(`${API}/api/locks`, {
    headers: auth(alice.token),
    data: { showId: 'show-1', seatIds: ['show-1-C区-1-1'] },
  });
  const { lock } = await lockRes.json();

  // alice 携带伪造 staffId 字段调用工作人员接口 → 403
  let res = await request.post(`${API}/api/admin/locks/${lock.id}/release`, {
    headers: auth(alice.token),
    data: { staffId: 'admin', role: 'staff' },
  });
  expect(res.status()).toBe(403);
  res = await request.get(`${API}/api/admin/state`, { headers: auth(alice.token) });
  expect(res.status()).toBe(403);

  // 锁座未被释放
  let s = await adminState(request, admin.token);
  expect(s.locks[0].status).toBe('active');

  // 真正的工作人员可以释放
  res = await request.post(`${API}/api/admin/locks/${lock.id}/release`, {
    headers: auth(admin.token),
  });
  expect(res.ok()).toBeTruthy();
  s = await adminState(request, admin.token);
  expect(s.locks[0].status).toBe('released');
});

test('公开状态不泄露他人订单与身份信息', async ({ request }) => {
  const alice = await loginApi(request, 'alice', 'alice123');
  const bob = await loginApi(request, 'bob', 'bob123');
  await createOrderApi(request, alice.token, 'show-1-A区-1-1', 'key-privacy-1');

  // 公开状态：无订单、无锁座归属、无用户标识
  const pub = await publicState(request);
  const raw = JSON.stringify(pub);
  expect(pub.orders).toBeUndefined();
  expect(pub.locks).toBeUndefined();
  expect(raw).not.toContain('alice');
  expect(raw).not.toContain('idempotencyKey');

  // bob 的私有视图中没有 alice 的订单
  const bobMine = await myState(request, bob.token);
  expect(bobMine.orders.length).toBe(0);
  expect(bobMine.locks.length).toBe(0);
});

test('退出登录后会话立即失效，过期会话被拒绝', async ({ page, request }) => {
  // 退出后会话失效
  const alice = await loginApi(request, 'alice', 'alice123');
  let res = await request.get(`${API}/api/my/state`, { headers: auth(alice.token) });
  expect(res.ok()).toBeTruthy();
  await request.post(`${API}/api/logout`, { headers: auth(alice.token) });
  res = await request.get(`${API}/api/my/state`, { headers: auth(alice.token) });
  expect(res.status()).toBe(401);

  // 过期会话被拒绝
  const bob = await loginApi(request, 'bob', 'bob123');
  await request.post(`${API}/api/__expire`, { data: { token: bob.token } });
  res = await request.get(`${API}/api/my/state`, { headers: auth(bob.token) });
  expect(res.status()).toBe(401);

  // UI 登录/退出流程
  await page.goto('/login');
  await page.getByTestId('login-username').fill('alice');
  await page.getByTestId('login-password').fill('wrong-password');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toContainText('用户名或密码错误');

  await page.getByTestId('login-password').fill('alice123');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('current-user')).toContainText('alice（用户）');

  await page.getByTestId('logout-button').click();
  await expect(page.getByTestId('go-login')).toBeVisible();
});
