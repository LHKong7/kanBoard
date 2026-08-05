/**
 * 从评论正文里解析被 @ 到的主体。
 *
 * 只有这一个地方解析，且**不存副本**。存一份 `mentions` 属性看起来更方便查询，
 * 但正文是可以改的——改完之后两份就对不上了，而对不上的那份会继续
 * 决定通知发给谁。让"谁被提到了"永远由正文当场回答，就不存在漂移。
 *
 * 顺带一条安全性质：解析发生在**服务端**。如果收件人由客户端自报，
 * 一条正文里谁都没提的评论可以把通知发给任意主体——
 * 而收件人是会被当作"有人点了我的名"来读的。
 */

/**
 * 认得两种写法：
 *
 *   `@user://alice`   完整主体，无歧义
 *   `@alice`          简写，补成 `user://alice`
 *
 * 简写只补 `user://`，**不猜 `agent://`**。要 @ 一个 Agent 就得把
 * `agent://` 写全——让人和 Agent 共用一套简写，会让"这条是谁干的"
 * 在最需要分清的地方变糊。
 *
 * 开头那个否定后视断言挡的是**邮箱**：正文里出现 `alice@example.com` 时，
 * 没有它就会解析出一个 `user://example.com` 的提及，然后给一个根本
 * 不存在的人发通知。评论里写邮箱太常见了，这不是边角情况。
 */
const MENTION = /(?<![\w.@])@((?:user|agent):\/\/[\w@.:-]{1,128}|[a-zA-Z0-9][\w.-]{0,63})/g

/** 主体形如 `user://alice`。与 api/auth.ts 的 principal 规则保持一致 */
const PRINCIPAL = /^(user|agent):\/\/[\w@.:-]{1,128}$/

/**
 * 一条评论提到了谁。返回去重后的主体清单，顺序按正文中首次出现。
 *
 * 顺序是有意义的：UI 要显示"提到了 A、B、C"，而按出现顺序读起来
 * 和正文对得上。用 Set 直接展开会得到插入序——正好就是首次出现序。
 */
export function parseMentions(body: unknown): string[] {
  if (typeof body !== 'string' || body === '') return []

  const found = new Set<string>()
  for (const match of body.matchAll(MENTION)) {
    const raw = match[1]
    if (raw === undefined || match.index === undefined) continue

    /**
     * `@user://` 后面是空的：这是一个**写坏的完整主体**，不是简写。
     *
     * 完整主体那个分支要求 `://` 后至少一个字符，匹配不上就落到简写分支，
     * 于是 `user` 被当成用户名，拼出 `user://user`——一个凭空出现的人。
     * 用后视判断而不是给正则加前瞻：前瞻会触发回溯，
     * `user` 退一格变成 `use`，结果更糟（`user://use`）。
     */
    if (!raw.includes('://') && body.slice(match.index + match[0].length).startsWith('://')) continue

    const principal = raw.includes('://') ? raw : `user://${raw}`
    if (PRINCIPAL.test(principal)) found.add(principal)
  }
  return [...found]
}

/**
 * 去掉自我提及。
 *
 * 给自己发通知没有任何用处，而且会污染"有人点了我的名"这件事——
 * 收件箱里一半是自己 @ 自己的话，真正需要看的那条就被淹了。
 */
export function mentionsExcluding(body: unknown, author: string | null): string[] {
  return parseMentions(body).filter((m) => m !== author)
}
