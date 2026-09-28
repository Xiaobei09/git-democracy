import {readVoters, Voters} from '../src/voters'
import {weightedVoteTotaling} from '../src/reactions'

test('readVoters can read a valid file', async () => {
  const expected = new Voters()
  expected.set('abc', 1)
  expected.set('xyz', 2)
  expected.set('foo', 1)

  await expect(
    readVoters('./__tests__/data/voters-valid.yml')
  ).resolves.toEqual(expected)
})

// ── 以下是把「守卫 vs 测试」逐条对表后补齐的分支断言 ──────────────────
// voters.ts 只有三处分支：构造器的 `if (obj)` 短路、`typeof val === 'number'`
// 过滤器、以及 readVoters 里的 `!(data instanceof Object)` 抛错。上游此前
// 只覆盖了「正常文件能读」这一条，另外三条零断言。

test('readVoters 遇到顶层是 null 的文件（只有 ---）必须抛错而不是静默当成空名单', async () => {
  // 注意：js-yaml 把「只有 ---」解析成 null，把 0 字节文件解析成 undefined。
  // 两者都是非 Object，都该被同一道守卫拦下——下面两条断言分别钉住它们，
  // 免得把「null 文档」误当成「空文件」而只测了其中一种。
  await expect(
    readVoters('./__tests__/data/voters-null-doc.yml')
  ).rejects.toThrowError('voters data is not object type')
})

test('readVoters 遇到真正的 0 字节空文件必须抛错（js-yaml 给出 undefined）', async () => {
  await expect(
    readVoters('./__tests__/data/voters-zero-byte.yml')
  ).rejects.toThrowError('voters data is not object type')
})

test('【口径边界】权重写成带引号的字符串会被【静默丢弃】，该投票人权重变成 0', async () => {
  // `abc: "1"` 解析成 string，过滤器 `typeof val === 'number'` 把它丢掉 ——
  // 不报错、不告警。而 weightedVoteTotating 对未登记的人用 `?? 0`，
  // 于是「引号手滑」的后果与「没登记」完全相同：那一票彻底消失。
  // 真实触发路径：从 JSON 片段复制权重时手滑加了引号（JSON 里数字常带引号）。
  const v = await readVoters('./__tests__/data/voters-quoted-weight.yml')
  expect(v.get('abc')).toBeUndefined() // 字符串权重被丢
  expect(v.get('xyz')).toBe(2) // 同一文件里的整数权重正常
  // 后果：abc 的票既不计 forIt 也不计 numVoters，等价于未登记
  const r = await weightedVoteTotaling(
    Promise.resolve(new Map([['abc', 1]])),
    Promise.resolve(v),
    Promise.resolve(new Date(0))
  )
  expect(r.numVoters).toBe(0)
  expect(r[forItKey()]).toBe(0)
})

test('null 权重同样被静默丢弃（不报错）', async () => {
  const v = await readVoters('./__tests__/data/voters-null-weight.yml')
  expect(v.get('abc')).toBeUndefined()
  expect(v.get('xyz')).toBe(2)
})

test('【漏洞·未修】顶层是数组时 `instanceof Object` 拦不住，会造出 "0"/"1" 两个假投票人', async () => {
  // Array 也是 Object 的实例，所以 `!(data instanceof Object)` 这道守卫对
  // 「顶层写成 YAML 列表」完全无效：readVoters 不报错，而是把数组下标当成
  // 投票人名，构造出 Voters { "0": 1, "1": 2 }。
  // 现状无实际危害（GitHub 登录名不会是 "0"），但它证明这道守卫的判据选错了：
  // 真正要排除的是「顶层不是平坦映射」，用 instanceof 判断不出来。
  // 改成 Array.isArray 排除 / 或按 config.ts 同样处理，属维护者决策（见 PR 提案）。
  const v = await readVoters('./__tests__/data/voters-toplist.yml')
  expect([...v.entries()]).toEqual([
    ['0', 1],
    ['1', 2]
  ])
})

test('负权重不被拦，原样进入 Voters（当前行为）', async () => {
  const v = await readVoters('./__tests__/data/voters-negative-weight.yml')
  expect(v.get('abc')).toBe(-1)
  expect(v.get('xyz')).toBe(2)
})

test('【口径边界·安全相关】-1 权重投反对票 = 把这条反对从 againstIt 里【减掉】，赞成率可 >100%', async () => {
  // 三个 1 权重赞成者 + 一名 -1 权重反对者：
  //   forIt = 3，againstIt = 1 + (-1) = -1  ->  3/(3-1) = 150%
  // 全部权重为 1 时同一场景是 3/4 = 75%（被 percentageToApprove:100 拦下），
  // 见下面那条「反证」——两个数据文件只差 `abc: -1` / `abc: 1` 一行。
  // 即：**.voters.yml 里一个负权重就能抹掉一条 CHANGES_REQUESTED**。
  // 这与 PR #50 的形状完全一致（3 人赞成 + 1 人反对 = 66.7% 长期阻塞）——
  // 若那名反对者权重为 -1，PR #50 会直接放行。
  // 未修：改它=改闸门语义，须维护者决策（PR 描述里写成了提案）。
  const v = await readVoters('./__tests__/data/voters-four-neg.yml')
  const reactions = new Map<string, number>([
    ['A', 1],
    ['D', 1],
    ['E', 1],
    ['abc', -1] // CHANGES_REQUESTED -> -1
  ])
  const r = await weightedVoteTotaling(
    Promise.resolve(reactions),
    Promise.resolve(v),
    Promise.resolve(new Date(0))
  )
  // 反对票被减成负数
  expect(r[againstItKey()]).toBe(-1)
  expect(r[forItKey()]).toBe(3)
  // 投票人只算权重 > 0 的三名，-1 权重者被剔出人数
  expect(r.numVoters).toBe(3)
  // 后果：百分比 150% >= 门槛 100% -> 放行
  const pct = (r[forItKey()] / (r[forItKey()] + r[againstItKey()])) * 100
  expect(pct).toBe(150)
  expect(pct < 100).toBe(false) // 百分比闸门不触发
})

test('【反证】同一场景只把 abc 的权重改回 1 -> 75% 被拦（证明上一条是 -1 权重造成的，不是场景本身）', async () => {
  const v = await readVoters('./__tests__/data/voters-four-ones.yml')
  const reactions = new Map<string, number>([
    ['A', 1],
    ['D', 1],
    ['E', 1],
    ['abc', -1] // 票没变，只改权重
  ])
  const r = await weightedVoteTotaling(
    Promise.resolve(reactions),
    Promise.resolve(v),
    Promise.resolve(new Date(0))
  )
  expect(r[againstItKey()]).toBe(1) // 反对票正常计入
  expect(r.numVoters).toBe(4) // -1 权重者这次也计入人数（权重 1 > 0）
  const pct = (r[forItKey()] / (r[forItKey()] + r[againstItKey()])) * 100
  expect(pct).toBe(75)
  expect(pct < 100).toBe(true) // 百分比闸门触发
})

// reactions.ts 用计算属性名导出这两个键，直接 import 会与 jest 的全局冲突，
// 这里按名取值，避免把字面量 '+1'/'-1' 散落在断言里。
function forItKey(): '+1' {
  return forIt
}
function againstItKey(): '-1' {
  return againstIt
}
import {forIt, againstIt} from '../src/reactions'
