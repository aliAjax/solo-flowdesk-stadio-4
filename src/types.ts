export type SeatStatus = 'available' | 'locked' | 'sold';
export type LockStatus = 'active' | 'converted' | 'released' | 'expired';
export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'payment_failed'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded';

export interface Show {
  id: string;
  name: string;
  venue: string;
  startsAt: string;
}

export interface Seat {
  id: string;
  showId: string;
  area: string;
  row: number;
  no: number;
  tier: string;
  price: number; // 分
  status: SeatStatus;
}

export interface Lock {
  id: string;
  showId: string;
  seatIds: string[];
  owner: string;
  status: LockStatus;
  createdAt: number;
  expiresAt: number;
}

export interface OrderItem {
  seatId: string;
  area: string;
  row: number;
  no: number;
  tier: string;
  price: number;
}

export interface RefundLine {
  seatId: string;
  area: string;
  row: number;
  no: number;
  tier: string;
  price: number;
  discountShare: number;
  amount: number;
}

export interface Refund {
  id: string;
  seatIds: string[];
  lines: RefundLine[];
  total: number;
  createdAt: number;
}

export interface Order {
  id: string;
  showId: string;
  lockId: string;
  owner: string;
  idempotencyKey: string;
  items: OrderItem[];
  couponId: string | null;
  subtotal: number;
  discount: number;
  discountAlloc: Record<string, number>;
  total: number;
  status: OrderStatus;
  refunds: Refund[];
  createdAt: number;
  payExpiresAt: number;
  paidAt?: number;
}

export interface Coupon {
  id: string;
  title: string;
  amount: number;
  quota: number;
  used: number;
}

export interface AppState {
  now: number;
  shows: Show[];
  seats: Seat[];
  coupons: Coupon[];
  lockTtlMs: number;
  payTtlMs: number;
}
