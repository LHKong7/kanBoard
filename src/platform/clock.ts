/**
 * 时钟以端口形式注入，使历史记录与 TTL 相关的测试不依赖真实时间。
 * Agent 授权的 TTL 判定（FR-IAM-006）尤其需要可控时钟。
 */
export type Clock = {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export function fixedClock(iso: string): Clock {
  const at = new Date(iso)
  return { now: () => at }
}
