import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 变异测试：**往代码里种一个缺陷，看用例会不会红。**
 *
 *   node --experimental-strip-types tools/mutate.ts           # 全跑
 *   node --experimental-strip-types tools/mutate.ts sync jira # 只跑这两份
 *
 * 为什么值得单独做一个工具：这个项目反复栽在同一件事上——
 * **一条从不失败的检查和没有这条检查是一回事，而它看起来是有的。**
 * 覆盖率回答"这行代码跑到了吗"，回答不了"这行代码写错了会有人知道吗"。
 * 那两个问题的答案经常不一样：
 *
 *   - `actionableItems` 把同一个条件写了两遍、方向相反。改坏一处，
 *     覆盖率 100%，用例全绿——而调用方拿到的是一份少了一条的清单
 *     加一句"全都有负责人"。
 *   - 阻塞原因的断言写成"含 CI 两个字"，于是把原因换成光秃秃的
 *     「CI 失败：」照样通过，而那对着手修的人一点用没有。
 *   - `decide` 里一个永远不成立的分支，删掉它全部用例照样绿。
 *
 * 这三条都是这个会话里被这个工具逮到的，不是假想的。
 *
 * **不进 `pnpm check`**：每个变异要跑一遍完整用例，一份 spec 就是几十秒。
 * 放进 check 的结果是有人加 `--skip-mutate`，然后再没人跑。
 * 它属于"改完一个模块之后手动跑一次"的那一类。
 */

type Mutation = {
  /** 人能读的描述：**这个缺陷是什么**，不是改了哪一行 */
  name: string
  /** 要替换的原文。必须唯一命中——命不中会报 ANCHOR-MISSING 而不是静默跳过 */
  from: string
  to: string
}

type Spec = {
  /** 被种缺陷的源文件 */
  file: string
  /** 跑哪些用例。空格分隔 */
  test: string
  /** 跑用例时要带的环境变量 */
  env?: Record<string, string>
  mutations: Mutation[]
}

const SPEC_DIR = 'tools/mutations'

function loadSpecs(names: readonly string[]): { name: string; spec: Spec }[] {
  const files = readdirSync(SPEC_DIR).filter((f) => f.endsWith('.json'))
  const wanted = names.length === 0 ? files : files.filter((f) => names.includes(f.replace('.json', '')))
  return wanted.map((f) => ({
    name: f.replace('.json', ''),
    spec: JSON.parse(readFileSync(join(SPEC_DIR, f), 'utf8')) as Spec,
  }))
}

/**
 * 跑一份 spec。
 *
 * 每次都从**原文**替换，不是在上一次的结果上接着改：
 * 累积修改会让第三个变异跑在一份已经被改花了的代码上，
 * 而那时"红了"说明不了任何事。
 */
function runTests(spec: Spec): boolean {
  try {
    execSync(`pnpm vitest run ${spec.test} --reporter=dot`, {
      stdio: 'pipe',
      env: { ...process.env, ...spec.env },
    })
    return true
  } catch {
    return false
  }
}

function runSpec(name: string, spec: Spec): { caught: number; survived: string[] } {
  const original = readFileSync(spec.file, 'utf8')
  const survived: string[] = []
  let caught = 0

  /**
   * 先跑一遍**没种缺陷的**代码。
   *
   * 这一步是被一次假的满分逼出来的：用例本身在基线上就是红的，
   * 于是每一个变异都"被逮到了"，报告是 7/7 —— 而它一个缺陷都没检验。
   * **一个总是红的用例和一个总是绿的用例，在这个工具眼里没有区别**，
   * 而后者至少还会被人注意到。
   */
  if (!runTests(spec)) {
    console.log('  BASELINE!! 用例在没种缺陷时就是红的，这份 spec 的结论无效')
    return { caught: 0, survived: ['BASELINE-RED  先把用例修绿，再谈变异'] }
  }

  // 进程被打断时必须把源文件放回去。留一份被种了缺陷的代码在工作区，
  // 比这个工具本身有用得多的东西都会被它毁掉
  const restore = (): void => writeFileSync(spec.file, original)
  process.on('SIGINT', () => {
    restore()
    process.exit(130)
  })

  try {
    for (const mutation of spec.mutations) {
      const hits = original.split(mutation.from).length - 1
      if (hits === 0) {
        survived.push(`ANCHOR-MISSING  ${mutation.name}`)
        console.log(`  ANCHOR!!  ${mutation.name}`)
        continue
      }
      if (hits > 1) {
        // 命中多处时替换哪一处是不确定的，于是这条变异的结论也是不确定的
        survived.push(`ANCHOR-AMBIGUOUS(${hits})  ${mutation.name}`)
        console.log(`  AMBIG!!   ${mutation.name} (matches ${hits} places)`)
        continue
      }

      writeFileSync(spec.file, original.replace(mutation.from, mutation.to))
      const red = !runTests(spec)
      writeFileSync(spec.file, original)

      if (red) caught++
      else survived.push(mutation.name)
      console.log(`  ${red ? 'caught  ' : 'SURVIVED'}  ${mutation.name}`)
    }
  } finally {
    restore()
  }

  console.log(`${name}: ${caught}/${spec.mutations.length} caught`)
  return { caught, survived }
}

const specs = loadSpecs(process.argv.slice(2))
if (specs.length === 0) {
  console.error(`no mutation specs matched. available: ${readdirSync(SPEC_DIR).join(', ')}`)
  process.exit(1)
}

let totalSurvived = 0
for (const { name, spec } of specs) {
  console.log(`\n── ${name} (${spec.file}) ──`)
  const { survived } = runSpec(name, spec)
  totalSurvived += survived.length
  for (const s of survived) console.log(`  ! ${s}`)
}

if (totalSurvived > 0) {
  console.error(
    `\n${totalSurvived} mutation(s) survived. Each one is a defect the tests would not catch — ` +
      'fix the test, or delete the code if the branch cannot happen.',
  )
  process.exit(1)
}
console.log('\nevery planted defect was caught')
