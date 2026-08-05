import { describe, expect, it } from 'vitest'
import { mentionsExcluding, parseMentions } from '../src/domain/collaboration/mentions.ts'

/**
 * 从评论正文解析 @ 到的主体。
 *
 * 这一层决定**通知发给谁**，所以它的失败模式不是"少显示一个名字"，
 * 而是"一条没提到你的评论把你叫醒了"，或者反过来
 * "有人点了你的名而你永远不知道"。
 */

describe('mentions are parsed from the body, and only from the body', () => {
  it('reads a full principal', () => {
    expect(parseMentions('麻烦 @user://alice 看一下')).toEqual(['user://alice'])
  })

  it('completes a bare handle to a user', () => {
    expect(parseMentions('@bob 这条你熟')).toEqual(['user://bob'])
  })

  it('reads an agent principal when written in full', () => {
    expect(parseMentions('@agent://planner@1.0.0 拆一下')).toEqual(['agent://planner@1.0.0'])
  })

  it('never guesses agent:// from a bare handle', () => {
    // 让人和 Agent 共用一套简写，会让"这条是谁干的"在最需要分清的地方变糊
    expect(parseMentions('@planner 拆一下')).toEqual(['user://planner'])
  })

  it('picks up several, de-duplicated, in the order they first appear', () => {
    // 顺序要和正文对得上，UI 才好显示"提到了 A、B"
    expect(parseMentions('@carol @dave 还有 @carol')).toEqual(['user://carol', 'user://dave'])
  })

  it('finds nothing when nobody was mentioned', () => {
    expect(parseMentions('这条我来处理')).toEqual([])
  })

  it('ignores an email-looking string that is not a mention', () => {
    // 正文里出现 a@b.com 不该变成 @b.com 的提及
    expect(parseMentions('发到 alice@example.com 就行')).toEqual([])
  })

  it('survives a body that is not a string', () => {
    // 属性是 unknown。传进来一个数字而这里崩掉的话，整条自动化都停了
    expect(parseMentions(undefined)).toEqual([])
    expect(parseMentions(42)).toEqual([])
    expect(parseMentions(null)).toEqual([])
    expect(parseMentions('')).toEqual([])
  })

  it('rejects a malformed principal instead of building a broken one', () => {
    // `@user://` 后面什么都没有时，简写分支会拼出 `user://user://`
    expect(parseMentions('@user:// 谁')).toEqual([])
  })
})

describe('you do not get notified about your own comment', () => {
  it('drops the author from the recipients', () => {
    // 收件箱里一半是自己 @ 自己的话，真正该看的那条就被淹了
    expect(mentionsExcluding('@alice @bob 看下', 'user://alice')).toEqual(['user://bob'])
  })

  it('keeps everyone when the author is unknown', () => {
    expect(mentionsExcluding('@alice 看下', null)).toEqual(['user://alice'])
  })
})
