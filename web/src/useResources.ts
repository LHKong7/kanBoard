import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from './api.ts'
import type { Resource } from './api.ts'

/**
 * 拉一类对象。
 *
 * 三个状态都暴露出去（loading / error / data），不合并成
 * "data 为空就是还没加载"——那种写法会把"加载失败"和"一条都没有"
 * 显示成同一个空白页面，而这两件事该说的话完全不同。
 */
export function useResources(type: string, params: Record<string, string> = {}) {
  const [items, setItems] = useState<Resource[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const key = JSON.stringify(params)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.list(type, JSON.parse(key) as Record<string, string>)
      setItems(result.items)
      setError(null)
    } catch (e) {
      // 权限不足是**正常**结果而不是故障：说清楚是哪一类看不了
      setError(e instanceof ApiError ? e.message : String(e))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [type, key])

  useEffect(() => {
    void reload()
  }, [reload])

  return { items, error, loading, reload }
}
