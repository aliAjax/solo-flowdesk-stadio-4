# 演出票务锁座与分账台

React + TypeScript + Vite 前端，零依赖 Node 后端（`server/server.mjs`）。所有写操作在服务端单线程同步临界区内完成，保证原子性；每次变更写穿 JSON 文件，重启与刷新后状态一致。

## 启动

需要 Node.js 20+。

```bash
npm install
npm run server   # 后端 http://127.0.0.1:4180
npm run dev      # 前端 http://localhost:5173（/api 代理到 4180）
```

## 测试

```bash
npx playwright install chromium
npm test
```

Playwright 会同时拉起后端（锁座 4s / 支付 8s 的短 TTL）和前端（4173 端口），串行执行 `tests/ticketing.spec.ts`。

## 功能与规则

- **余票展示**：场次列表按票档显示余票；座位图按区域 → 排 → 座位号展示，区分可选/已选/锁定中/已售。
- **限时锁座**：多选座位后一键锁定（默认 120s，可用 `TICKET_LOCK_TTL_MS` 调整），面板显示倒计时，超时自动释放回票池。
- **原子下单**：提交订单时服务端整体校验全部座位仍被该锁持有，任一失效则整单 409，绝不部分锁定；幂等键按用户隔离，重复提交返回本人的原订单，键冲突也不会返回他人订单。
- **登录会话**：登录后服务端签发不可预测的会话令牌（`crypto.randomBytes`），前端以 `Authorization: Bearer` 携带；令牌缺失、伪造或过期一律 401，退出登录立即失效。演示账号：alice/alice123、bob/bob123（用户），admin/admin123（工作人员）。
- **权限边界**：支付、退款、建单、查询本人订单的身份全部取自服务端会话，不接受客户端自报；工作人员接口要求会话角色为 staff，普通账号伪造工号字段无效（403）；公开状态接口不含任何订单、锁座归属与用户标识。
- **并发抢座**：两个标签页同时锁同一座位，服务端串行处理，最多一个成功，其余收到 409 冲突。
- **支付回滚**：下单时预占优惠名额；支付失败（或支付超时）自动释放座位并归还优惠名额。
- **部分退款**：已支付订单可按座位退款，优惠按票价占比（最大余数法）分摊到每个座位，退款单列明每个座位的票档、票价、分摊优惠与实退金额；已退座位回到票池。
- **工作人员台**：可释放异常锁座（含取消待支付订单）；已支付订单受保护，前端隐藏操作按钮，API 同样返回 409。
- **状态一致**：服务端写穿持久化，前端轮询 + 聚焦刷新，刷新页面后座位、订单、退款状态一致。

## 环境变量（后端）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `4180` | 服务端口 |
| `TICKET_DB` | `server/data.json` | 持久化文件 |
| `TICKET_LOCK_TTL_MS` | `120000` | 锁座时长 |
| `TICKET_PAY_TTL_MS` | `180000` | 待支付时长 |
| `ALLOW_RESET` | - | 置 `1` 开启 `/api/__reset`（仅测试用） |

## 主要接口

- `POST /api/login` / `POST /api/logout` 登录/退出（签发与注销会话令牌）
- `GET /api/state` 公开状态（场次/座位状态/优惠券，无订单与身份信息）
- `GET /api/my/state` 本人锁座与订单（需会话）
- `POST /api/locks` 锁座（需会话，同用户同座位集合幂等）
- `POST /api/orders` 下单（需会话，`idempotencyKey` 按用户隔离）
- `POST /api/orders/:id/pay` `{result: success|failure}` 模拟支付（仅订单所有者）
- `POST /api/orders/:id/refund` `{seatIds}` 部分退款（仅订单所有者）
- `GET /api/admin/state`、`POST /api/admin/locks/:id/release` 工作人员接口（需 staff 角色）
