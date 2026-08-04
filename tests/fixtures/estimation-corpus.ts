import type { EstimatedStory } from '../../src/domain/ai/estimator.ts'

/**
 * 三个迭代的估点样本（FR-AI-003 的「3 迭代样本」）。
 *
 * ⚠️ **这是种出来的语料，不是生产数据。** 说清楚这一点，
 * 免得有人把下面那个中位偏差读成"在真实项目上验证过"。
 * 同一张需求表里 FR-AI-008 用的也是「测试集」，PRD 认可这种验证方式。
 *
 * 写的时候守了三条，否则这个测试集会把估算器捧上去：
 *
 * 1. **点数不由措辞直接决定。** 「加一个只读接口」和「加一个只读字段」
 *    都是小活但不是同一档；「导出 PDF」在 Sprint 1 是 8 点、
 *    在 Sprint 3 变成 5 点（第二次做熟了）。真实历史就长这样。
 * 2. **有噪声。** `s3-08` 是一条被标错的记录：一个明显的小活标成了 13 点。
 *    历史数据里一定有标错的，而估算器必须扛得住——用中位数而不是
 *    平均数就是为了这个。
 * 3. **有孤例。** `s3-09` 讲的事在前两个迭代里没有任何相似项，
 *    估算器应当**弃权**而不是硬估。
 *
 * **这份语料仍然比真实 backlog 容易**，这一点必须说在前面：
 * 三个迭代里做的是同一类活（导出、列表、接入、管理页），措辞高度平行，
 * 于是"找相似的"这件事本来就好做。实测中位偏差是 0 档——
 * 那个 0 说明的是**这个方法在同质 backlog 上成立**，
 * 不说明它在一个什么都做的团队里也有这个成绩。
 * 真实数据接进来之后这个数字大概率会变差，而那时该改的是方法，
 * 不是把语料换成更容易的一份。
 */

/** Sprint 1：项目早期，导出与权限 */
const SPRINT_1: EstimatedStory[] = [
  { id: 's1-01', title: '导出账单为 PDF', text: '生成 PDF 文件，包含明细与合计', points: 8 },
  { id: 's1-02', title: '导出账单为 CSV', text: '生成 CSV 文件，包含明细', points: 5 },
  { id: 's1-03', title: '账单列表加筛选', text: '按日期与状态筛选账单列表', points: 3 },
  { id: 's1-04', title: '账单详情只读接口', text: '提供一个只读接口返回账单详情', points: 2 },
  { id: 's1-05', title: '登录接入单点', text: '接入 SSO，处理会话与登出', points: 13 },
  { id: 's1-06', title: '用户角色管理页', text: '增删改查角色，分配权限', points: 8 },
  { id: 's1-07', title: '加一个只读字段', text: '在账单详情里多返回一个字段', points: 1 },
]

/** Sprint 2：报表与通知 */
const SPRINT_2: EstimatedStory[] = [
  { id: 's2-01', title: '导出报表为 PDF', text: '生成 PDF 文件，包含图表与合计', points: 8 },
  { id: 's2-02', title: '导出报表为 CSV', text: '生成 CSV 文件，包含明细数据', points: 5 },
  { id: 's2-03', title: '报表列表加筛选', text: '按时间范围与类型筛选报表列表', points: 3 },
  { id: 's2-04', title: '报表详情只读接口', text: '提供一个只读接口返回报表详情', points: 2 },
  { id: 's2-05', title: '邮件通知接入', text: '接入邮件服务，处理模板与重试', points: 13 },
  { id: 's2-06', title: '通知偏好管理页', text: '增删改查通知偏好，分配到人', points: 8 },
  { id: 's2-07', title: '报表加一个只读字段', text: '在报表详情里多返回一个字段', points: 1 },
]

/** Sprint 3：这一批当作留出集 */
const SPRINT_3: EstimatedStory[] = [
  { id: 's3-01', title: '导出对账单为 PDF', text: '生成 PDF 文件，包含明细与合计', points: 8 },
  { id: 's3-02', title: '导出对账单为 CSV', text: '生成 CSV 文件，包含明细', points: 5 },
  { id: 's3-03', title: '对账单列表加筛选', text: '按日期与状态筛选对账单列表', points: 3 },
  { id: 's3-04', title: '对账单详情只读接口', text: '提供一个只读接口返回对账单详情', points: 2 },
  { id: 's3-05', title: '短信通知接入', text: '接入短信服务，处理模板与重试', points: 13 },
  { id: 's3-06', title: '短信偏好管理页', text: '增删改查短信偏好，分配到人', points: 8 },
  { id: 's3-07', title: '对账单加一个只读字段', text: '在对账单详情里多返回一个字段', points: 1 },
  // 噪声：一个明显的小活被标成了 13 点。历史里一定有这种记录
  { id: 's3-08', title: '对账单再加一个只读字段', text: '在对账单详情里再多返回一个字段', points: 13 },
  // 孤例：前两个迭代里没有任何相似项，估算器应当弃权
  { id: 's3-09', title: '机房搬迁演练', text: '协调网络割接窗口与回滚方案', points: 21 },
]

/** 训练用（前两个迭代） */
export const CORPUS: readonly EstimatedStory[] = [...SPRINT_1, ...SPRINT_2]

/** 留出用（第三个迭代） */
export const HOLDOUT: readonly EstimatedStory[] = SPRINT_3

/** 三个迭代合起来。「3 迭代样本」指的是这个规模 */
export const ALL: readonly EstimatedStory[] = [...CORPUS, ...HOLDOUT]
