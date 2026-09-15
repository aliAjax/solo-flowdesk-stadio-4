import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const API = 'http://127.0.0.1:4180';

async function reset(request: APIRequestContext) {
  const res = await request.post(`${API}/api/__reset`);
  expect(res.ok()).toBeTruthy();
}

async function state(request: APIRequestContext) {
  const res = await request.get(`${API}/api/state`);
  return res.json();
}

async function lockSeatsViaUI(page: Page, seatIds: string[]) {
  for (const id of seatIds) await page.getByTestId(`seat-${id}`).click();
  await page.getByTestId('lock-button').click();
  await expect(page.getByTestId('checkout-panel')).toBeVisible();
}

/** 通过 API 为指定用户锁座并下单，返回订单。 */
async function createOrderApi(
  request: APIRequestContext,
  owner: string,
  seatId: string,
  idempotencyKey: string,
) {
  const lockRes = await request.post(`${API}/api/locks`, {
    data: { showId: 'show-1', seatIds: [seatId], owner },
  });
  expect(lockRes.ok()).toBeTruthy();
  const { lock } = await lockRes.json();
  const orderRes = await request.post(`${API}/api/orders`, {
    data: { lockId: lock.id, owner, idempotencyKey },
  });
  expect(orderRes.ok()).toBeTruthy();
  return (await orderRes.json()).order;
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
  // 排号与座位号展示
  await expect(page.getByTestId('seat-show-1-A区-1-1')).toBeVisible();
  await expect(page.getByTestId('seat-show-1-A区-3-8')).toBeVisible();
  await expect(page.getByTestId('seat-show-1-C区-4-12')).toBeVisible();
});

test('两个标签页同时抢同一座位，最多一个成功', async ({ browser, request }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const seat = 'show-1-A区-1-1';

  await pageA.goto('/shows/show-1');
  await pageB.goto('/shows/show-1');
  await pageA.getByTestId(`seat-${seat}`).click();
  await pageB.getByTestId(`seat-${seat}`).click();

  // 同时点击锁定
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

  // 服务端只有一条活跃锁
  const s = await state(request);
  const activeLocks = s.locks.filter((l: any) => l.status === 'active' && l.seatIds.includes(seat));
  expect(activeLocks.length).toBe(1);

  await ctxA.close();
  await ctxB.close();
});

test('高并发 API 抢同一座位，10 个请求仅 1 个成功', async ({ request }) => {
  const seat = 'show-1-A区-1-2';
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      request.post(`${API}/api/locks`, {
        data: { showId: 'show-1', seatIds: [seat], owner: `user-${i}` },
      }),
    ),
  );
  const ok = results.filter((r) => r.ok());
  const conflict = results.filter((r) => r.status() === 409);
  expect(ok.length).toBe(1);
  expect(conflict.length).toBe(9);
});

test('重复点击提交不会重复建单', async ({ page, request }) => {
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-A区-1-1', 'show-1-A区-1-2']);

  // 快速双击提交订单
  await page.getByTestId('submit-order').dblclick();
  await expect(page.getByTestId('pay-panel')).toBeVisible();

  const s = await state(request);
  expect(s.orders.length).toBe(1);
  expect(s.orders[0].items.length).toBe(2);
  expect(s.orders[0].status).toBe('pending_payment');
});

test('支付失败释放座位和优惠名额', async ({ page, request }) => {
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-A区-1-1']);

  await page.getByTestId('coupon-select').selectOption('coupon-early');
  await page.getByTestId('submit-order').click();
  await expect(page.getByTestId('pay-panel')).toBeVisible();

  // 下单后优惠名额被占用
  let s = await state(request);
  expect(s.coupons.find((c: any) => c.id === 'coupon-early').used).toBe(1);

  await page.getByTestId('pay-failure').click();
  await expect(page.getByTestId('flow-message')).toContainText('支付失败');

  // 座位恢复可选、优惠名额释放
  await expect(page.getByTestId('seat-show-1-A区-1-1')).toBeEnabled();
  s = await state(request);
  expect(s.coupons.find((c: any) => c.id === 'coupon-early').used).toBe(0);
  expect(s.seats.find((x: any) => x.id === 'show-1-A区-1-1').status).toBe('available');
  expect(s.orders[0].status).toBe('payment_failed');

  await page.goto('/orders');
  await expect(page.getByTestId(`status-${s.orders[0].id}`)).toContainText('支付失败');
});

test('锁座超时自动释放并显示剩余时间', async ({ page, request }) => {
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-B区-1-1']);

  // 倒计时显示（锁 TTL 在测试环境为 4 秒）
  const countdown = page.getByTestId('lock-countdown');
  await expect(countdown).toContainText('锁座剩余时间');
  await expect(countdown).toContainText(/0:0[1-4]/);

  // 等待超时后自动释放：座位恢复可选，面板回到选座态
  await expect(page.getByTestId('checkout-panel')).toBeHidden({ timeout: 15000 });
  await expect(page.getByTestId('select-panel')).toBeVisible();
  await expect(page.getByTestId('seat-show-1-B区-1-1')).toBeEnabled();

  const s = await state(request);
  expect(s.locks[0].status).toBe('expired');
  expect(s.seats.find((x: any) => x.id === 'show-1-B区-1-1').status).toBe('available');
});

test('部分退款按票档分摊并列出明细', async ({ page, request }) => {
  await page.goto('/shows/show-1');
  // VIP ¥680、甲票 ¥480、乙票 ¥280，使用早鸟立减 ¥50
  await lockSeatsViaUI(page, ['show-1-A区-1-1', 'show-1-B区-1-1', 'show-1-C区-1-1']);
  await page.getByTestId('coupon-select').selectOption('coupon-early');
  await page.getByTestId('submit-order').click();
  await expect(page.getByTestId('pay-panel')).toBeVisible();
  await page.getByTestId('pay-success').click();
  await expect(page.getByTestId('flow-message')).toContainText('支付成功');

  await page.goto('/orders');
  const s0 = await state(request);
  const orderId = s0.orders[0].id;
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('已支付');

  // 退 VIP 和乙票两个座位
  await page.getByTestId('refund-check-show-1-A区-1-1').check();
  await page.getByTestId('refund-check-show-1-C区-1-1').check();
  await page.getByTestId(`refund-button-${orderId}`).click();

  // 分摊：¥50 按票价占比 → VIP 摊 ¥23.61、甲票 ¥16.67、乙票 ¥9.72
  // 实退：VIP 680-23.61=656.39，乙票 280-9.72=270.28，合计 926.67
  await expect(page.getByTestId('refund-message')).toContainText('共退 ¥926.67');
  const refundId = s0.orders[0].id && (await state(request)).orders[0].refunds[0].id;
  const detail = page.getByTestId(`refund-${refundId}`);
  await expect(detail).toContainText('VIP');
  await expect(detail).toContainText('¥656.39');
  await expect(detail).toContainText('乙票');
  await expect(detail).toContainText('¥270.28');
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('部分退款');

  // 已退座位回到票池
  const s1 = await state(request);
  expect(s1.seats.find((x: any) => x.id === 'show-1-A区-1-1').status).toBe('available');
  expect(s1.seats.find((x: any) => x.id === 'show-1-C区-1-1').status).toBe('available');
  expect(s1.seats.find((x: any) => x.id === 'show-1-B区-1-1').status).toBe('sold');

  // 退掉最后一个座位 → 全额退款
  await page.getByTestId('refund-check-show-1-B区-1-1').check();
  await page.getByTestId(`refund-button-${orderId}`).click();
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('已全额退款');
});

test('工作人员可释放异常锁座，但不能操作已支付订单', async ({ page, request }) => {
  // 制造一个异常锁座（用户锁座后离开）
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-C区-2-3']);

  await page.goto('/admin');
  const s0 = await state(request);
  const lockId = s0.locks[0].id;
  await expect(page.getByTestId(`admin-lock-${lockId}`)).toBeVisible();
  await page.getByTestId(`release-${lockId}`).click();
  await expect(page.getByTestId('admin-message')).toContainText('已释放');

  const s1 = await state(request);
  expect(s1.locks[0].status).toBe('released');
  expect(s1.seats.find((x: any) => x.id === 'show-1-C区-2-3').status).toBe('available');

  // 已支付订单不可操作
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-C区-2-4']);
  await page.getByTestId('submit-order').click();
  await page.getByTestId('pay-success').click();
  await expect(page.getByTestId('flow-message')).toContainText('支付成功');

  await page.goto('/admin');
  const s2 = await state(request);
  const paidLock = s2.locks.find((l: any) => l.status === 'converted');
  await expect(page.getByTestId(`protected-${paidLock.id}`)).toContainText('已支付订单，不可操作');
  await expect(page.getByTestId(`release-${paidLock.id}`)).toHaveCount(0);

  // API 层同样被拒绝：带工作人员身份 → 409 已支付不可操作；无身份 → 403
  const resStaff = await request.post(`${API}/api/admin/locks/${paidLock.id}/release`, {
    data: { staffId: 'staff-01' },
  });
  expect(resStaff.status()).toBe(409);
  const resAnon = await request.post(`${API}/api/admin/locks/${paidLock.id}/release`);
  expect(resAnon.status()).toBe(403);
});

test('刷新后座位、订单和退款状态一致', async ({ page, request }) => {
  await page.goto('/shows/show-1');
  await lockSeatsViaUI(page, ['show-1-A区-2-1', 'show-1-A区-2-2']);

  // 刷新后锁座与倒计时仍在
  await page.reload();
  await expect(page.getByTestId('checkout-panel')).toBeVisible();
  await expect(page.getByTestId('lock-countdown')).toContainText('锁座剩余时间');
  await expect(page.getByTestId('seat-show-1-A区-2-1')).toHaveClass(/locked/);

  // 支付成功后刷新，订单状态保持
  await page.getByTestId('submit-order').click();
  await page.getByTestId('pay-success').click();
  await expect(page.getByTestId('flow-message')).toContainText('支付成功');
  await page.reload();
  await page.goto('/orders');
  const s = await state(request);
  const orderId = s.orders[0].id;
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('已支付');

  // 退款一个座位后刷新，退款明细保持
  await page.getByTestId('refund-check-show-1-A区-2-1').check();
  await page.getByTestId(`refund-button-${orderId}`).click();
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('部分退款');
  await page.reload();
  await expect(page.getByTestId(`status-${orderId}`)).toContainText('部分退款');
  await expect(page.getByTestId(`refund-${s.orders[0].id && (await state(request)).orders[0].refunds[0].id}`)).toBeVisible();
  await expect(page.getByTestId(`refund-line-show-1-A区-2-1`)).toBeVisible();
});

test('跨用户支付被拒绝且订单状态不变', async ({ request }) => {
  const order = await createOrderApi(request, 'user-A', 'show-1-A区-1-1', 'key-pay-1');

  // 其他用户尝试支付 → 403
  const res = await request.post(`${API}/api/orders/${order.id}/pay`, {
    data: { result: 'success', owner: 'user-B' },
  });
  expect(res.status()).toBe(403);

  // 订单状态未变
  let s = await state(request);
  expect(s.orders[0].status).toBe('pending_payment');
  expect(s.seats.find((x: any) => x.id === 'show-1-A区-1-1').status).toBe('locked');

  // 所有者本人支付成功
  const ok = await request.post(`${API}/api/orders/${order.id}/pay`, {
    data: { result: 'success', owner: 'user-A' },
  });
  expect(ok.ok()).toBeTruthy();
  s = await state(request);
  expect(s.orders[0].status).toBe('paid');
});

test('跨用户退款被拒绝且订单状态不变', async ({ request }) => {
  const order = await createOrderApi(request, 'user-A', 'show-1-A区-1-1', 'key-refund-1');
  await request.post(`${API}/api/orders/${order.id}/pay`, {
    data: { result: 'success', owner: 'user-A' },
  });

  // 其他用户尝试退款 → 403
  const res = await request.post(`${API}/api/orders/${order.id}/refund`, {
    data: { seatIds: ['show-1-A区-1-1'], owner: 'user-B' },
  });
  expect(res.status()).toBe(403);

  // 订单与退款记录未变
  let s = await state(request);
  expect(s.orders[0].status).toBe('paid');
  expect(s.orders[0].refunds.length).toBe(0);
  expect(s.seats.find((x: any) => x.id === 'show-1-A区-1-1').status).toBe('sold');

  // 所有者本人退款成功
  const ok = await request.post(`${API}/api/orders/${order.id}/refund`, {
    data: { seatIds: ['show-1-A区-1-1'], owner: 'user-A' },
  });
  expect(ok.ok()).toBeTruthy();
  s = await state(request);
  expect(s.orders[0].status).toBe('refunded');
});

test('普通用户不能调用工作人员接口', async ({ request }) => {
  const lockRes = await request.post(`${API}/api/locks`, {
    data: { showId: 'show-1', seatIds: ['show-1-C区-1-1'], owner: 'user-A' },
  });
  const { lock } = await lockRes.json();

  // 无身份 → 403
  let res = await request.post(`${API}/api/admin/locks/${lock.id}/release`);
  expect(res.status()).toBe(403);
  // 普通用户身份 → 403
  res = await request.post(`${API}/api/admin/locks/${lock.id}/release`, {
    data: { staffId: 'user-A' },
  });
  expect(res.status()).toBe(403);

  // 锁座未被释放
  let s = await state(request);
  expect(s.locks[0].status).toBe('active');

  // 工作人员身份 → 成功
  res = await request.post(`${API}/api/admin/locks/${lock.id}/release`, {
    data: { staffId: 'staff-02' },
  });
  expect(res.ok()).toBeTruthy();
  s = await state(request);
  expect(s.locks[0].status).toBe('released');
});

test('幂等键按用户隔离，冲突时不返回他人订单', async ({ request }) => {
  const KEY = 'shared-key-1';
  const orderA = await createOrderApi(request, 'user-A', 'show-1-A区-1-1', KEY);

  // 另一用户使用相同幂等键 → 创建属于自己的新订单，而非返回 user-A 的订单
  const orderB = await createOrderApi(request, 'user-B', 'show-1-A区-1-2', KEY);
  expect(orderB.id).not.toBe(orderA.id);
  expect(orderB.owner).toBe('user-B');

  // user-A 重复提交同键 → 返回自己的原订单，不重复建单
  const dup = await request.post(`${API}/api/orders`, {
    data: { lockId: 'whatever', owner: 'user-A', idempotencyKey: KEY },
  });
  const dupBody = await dup.json();
  expect(dupBody.order.id).toBe(orderA.id);
  expect(dupBody.idempotent).toBe(true);

  const s = await state(request);
  expect(s.orders.length).toBe(2);
});
