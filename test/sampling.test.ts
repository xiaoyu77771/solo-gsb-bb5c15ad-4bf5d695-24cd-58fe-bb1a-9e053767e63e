import assert from 'node:assert'
import { createHash } from 'node:crypto'
import {
  annotationContentSignature,
  buildSamplingPlan,
  makeSamplingConfig,
  normalizeSampleReviews,
  normalizeSamplingConfig,
  pruneSampleReviews,
  sampleOrderHash,
  sampleReviewKey,
  samplingConfigKey,
} from '../src/lib/sampling'
import type { Annotation, SampleReview } from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let seq = 0
function ann(
  start: number,
  end: number,
  tags: string[] = [],
  id?: string,
  opts: Partial<Annotation> = {},
): Annotation {
  seq += 1
  return {
    id: id ?? `a${seq}`,
    quote: '',
    start,
    end,
    note: '',
    tags,
    status: 'bound',
    createdAt: 0,
    updatedAt: 0,
    contextBefore: '',
    contextAfter: '',
    ...opts,
  }
}

// 1. 哈希：SHA-256(种子 + 标注 ID)，与 Node crypto 一致
check('顺序哈希为 SHA-256(种子+标注 ID)', () => {
  const got = sampleOrderHash('种子X', 'id-1')
  const want = createHash('sha256').update('种子Xid-1', 'utf8').digest('hex')
  assert.strictEqual(got, want)
  // 不同种子 / 不同 ID → 不同哈希
  assert.notStrictEqual(sampleOrderHash('s1', 'id-1'), sampleOrderHash('s2', 'id-1'))
  assert.notStrictEqual(sampleOrderHash('s1', 'id-1'), sampleOrderHash('s1', 'id-2'))
})

// 2. 无配置 → 空计划
check('配置为 null 时队列为空', () => {
  const plan = buildSamplingPlan(null, [ann(0, 2, ['T'], 'a1')])
  assert.deepStrictEqual(plan.queue, [])
  assert.strictEqual(plan.fulfilled, true)
})

// 3. 确定性：同一配置 + 同一标注集得到完全相同队列
check('同一配置重复计算得到完全相同的队列', () => {
  const anns = Array.from({ length: 30 }, (_, i) =>
    ann(i * 2, i * 2 + 1, ['X'], `id${String(i).padStart(3, '0')}`),
  )
  const cfg = makeSamplingConfig([{ tag: 'X', count: 10 }], 'seed-2026')!
  const p1 = buildSamplingPlan(cfg, anns)
  const p2 = buildSamplingPlan(makeSamplingConfig([{ tag: 'X', count: 10 }], 'seed-2026'), anns)
  assert.deepStrictEqual(p1.queue, p2.queue)
  assert.strictEqual(p1.queue.length, 10)
  // 打乱标注输入顺序不影响结果
  const shuffled = [...anns].reverse()
  const p3 = buildSamplingPlan(cfg, shuffled)
  assert.deepStrictEqual(p3.queue.map((q) => q.annotationId), p1.queue.map((q) => q.annotationId))
})

// 4. 只从已绑定、区间非空标注取样；不命中配额标签的不入选
check('待处理 / 空区间 / 未命中标签的标注不进入候选', () => {
  const anns = [
    ann(0, 2, ['X'], 'bound-ok'),
    ann(3, 5, ['X'], 'pending-1', { status: 'pending' }),
    ann(6, 6, ['X'], 'empty-range'),
    ann(7, 9, ['Y'], 'other-tag'),
  ]
  const cfg = makeSamplingConfig([{ tag: 'X', count: 5 }], 's')!
  const plan = buildSamplingPlan(cfg, anns)
  assert.strictEqual(plan.candidateCount, 1)
  assert.deepStrictEqual(plan.queue.map((q) => q.annotationId), ['bound-ok'])
  assert.strictEqual(plan.tags[0].pool, 1)
  assert.strictEqual(plan.tags[0].actual, 1)
  assert.strictEqual(plan.tags[0].gap, 4)
  assert.strictEqual(plan.fulfilled, false)
})

// 5. 配额满足：单标签取够即停
check('单标签配额满足后停止取样', () => {
  const anns = Array.from({ length: 20 }, (_, i) => ann(i, i + 1, ['X'], `x${i}`))
  const plan = buildSamplingPlan(makeSamplingConfig([{ tag: 'X', count: 5 }], 's')!, anns)
  assert.strictEqual(plan.queue.length, 5)
  assert.strictEqual(plan.tags[0].gap, 0)
  assert.strictEqual(plan.fulfilled, true)
})

// 6. 贪心优先级：优先选择补足更多尚缺标签的标注
check('多标签时优先选择能补足最多尚缺配额的标注', () => {
  // 找到一个种子，使多标签标注 ab 的哈希排在全部单标签候选之前；
  // 贪心应先取 ab（一次补两个标签），队列长度为 1。
  const singlesA: Annotation[] = []
  const singlesB: Annotation[] = []
  for (let i = 0; i < 60; i++) {
    singlesA.push(ann(i * 2, i * 2 + 1, ['X'], `aa${i}`))
    singlesB.push(ann(200 + i * 2, 201 + i * 2, ['Y'], `bb${i}`))
  }
  const singleIds = [...singlesA, ...singlesB].map((a) => a.id)
  let seed = ''
  for (let i = 0; i < 100000; i++) {
    const candidate = `greedy-${i}`
    const abHash = sampleOrderHash(candidate, 'ab')
    if (singleIds.every((id) => sampleOrderHash(candidate, id) > abHash)) {
      seed = candidate
      break
    }
  }
  assert.ok(seed, '应能找到使 ab 哈希最靠前的种子')

  const ab = ann(500, 502, ['X', 'Y'], 'ab')
  const cfg = makeSamplingConfig(
    [
      { tag: 'X', count: 1 },
      { tag: 'Y', count: 1 },
    ],
    seed,
  )!
  const plan = buildSamplingPlan(cfg, [...singlesA, ...singlesB, ab])
  assert.strictEqual(plan.queue.length, 1, '多标签标注应一次补足两个配额')
  assert.strictEqual(plan.queue[0].annotationId, 'ab')
  assert.deepStrictEqual([...plan.queue[0].matchedTags].sort(), ['X', 'Y'])
})

// 7. 同补足数时按哈希、再按 ID 排序
check('同补足数时按哈希升序、哈希相同按 ID 升序', () => {
  const anns: Annotation[] = Array.from({ length: 40 }, (_, i) =>
    ann(i, i + 1, ['X'], `t${i}`),
  )
  const cfg = makeSamplingConfig([{ tag: 'X', count: 8 }], 'tie-seed')!
  const plan = buildSamplingPlan(cfg, anns)
  // 单标签场景：所有候选补足数恒为 1，队列即哈希升序前 8 个
  const expected = anns
    .map((a) => ({ id: a.id, h: sampleOrderHash('tie-seed', a.id) }))
    .sort((x, y) => (x.h < y.h ? -1 : x.h > y.h ? 1 : x.id < y.id ? -1 : 1))
    .slice(0, 8)
    .map((x) => x.id)
  assert.deepStrictEqual(plan.queue.map((q) => q.annotationId), expected)
})

// 8. 实际计数按标签集合（同条多标签只计一次）；缺口 = 目标 - 实际
check('一条多标签标注对每个命中标签各计一次且每标签不重复计数', () => {
  const anns = [
    ann(0, 2, ['X', 'Y'], 'ab1'),
    ann(2, 4, ['X', 'Y'], 'ab2'),
    ann(4, 6, ['X'], 'a1'),
  ]
  const plan = buildSamplingPlan(
    makeSamplingConfig(
      [
        { tag: 'X', count: 2 },
        { tag: 'Y', count: 2 },
      ],
      's',
    )!,
    anns,
  )
  const x = plan.tags.find((t) => t.tag === 'X')!
  const y = plan.tags.find((t) => t.tag === 'Y')!
  assert.strictEqual(x.actual, 2)
  assert.strictEqual(y.actual, 2)
  assert.strictEqual(x.gap, 0)
  assert.strictEqual(y.gap, 0)
  assert.strictEqual(plan.queue.length, 2)
})

// 9. 候选耗尽：能取的都取，缺口保留
check('候选耗尽时取完全部有效候选并报告缺口', () => {
  const anns = [
    ann(0, 2, ['X'], 'x1'),
    ann(2, 4, ['Y'], 'y1'),
  ]
  const plan = buildSamplingPlan(
    makeSamplingConfig(
      [
        { tag: 'X', count: 3 },
        { tag: 'Y', count: 3 },
      ],
      's',
    )!,
    anns,
  )
  assert.strictEqual(plan.queue.length, 2)
  assert.deepStrictEqual(
    plan.tags.map((t) => [t.tag, t.target, t.actual, t.gap]),
    [
      ['X', 3, 1, 2],
      ['Y', 3, 1, 2],
    ],
  )
  assert.strictEqual(plan.fulfilled, false)
})

// 10. 一旦某标签配额已满，带该标签的标注在后续轮次只按其它尚缺标签计补足数
check('已满足标签不再占用计数，后续优先补其它缺口', () => {
  const seed = 'rolling'
  // 两条多标签标注 + 若干仅 Y 的标注，构造 Y 缺口
  const anns = [
    ann(0, 2, ['X', 'Y'], 'xy1'),
    ann(2, 4, ['X'], 'x2'),
    ann(4, 6, ['Y'], 'y2'),
    ann(6, 8, ['Y'], 'y3'),
  ]
  const plan = buildSamplingPlan(
    makeSamplingConfig(
      [
        { tag: 'X', count: 2 },
        { tag: 'Y', count: 2 },
      ],
      seed,
    )!,
    anns,
  )
  const x = plan.tags.find((t) => t.tag === 'X')!
  const y = plan.tags.find((t) => t.tag === 'Y')!
  assert.strictEqual(x.actual, 2)
  assert.strictEqual(y.actual, 2)
  // 中选集合恰好覆盖配额所需（共 3 条：两条 X 中一条须带 Y，再加一条纯 Y）
  assert.strictEqual(plan.queue.length, 3)
  const ids = new Set(plan.queue.map((q) => q.annotationId))
  assert.ok(ids.has('xy1'))
  assert.ok(ids.has('x2'))
  assert.ok(ids.has('y2') || ids.has('y3'))
})

// 11. 内容签名：内容变化则改变
check('标注内容变化后内容签名改变', () => {
  const a = ann(0, 4, ['X'], 'a1', { quote: '引文', note: '备注' })
  const s0 = annotationContentSignature(a)
  assert.strictEqual(s0, annotationContentSignature({ ...a, tags: [...a.tags] }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, note: '改' }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, tags: ['Y'] }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, quote: '引' }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, start: 1 }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, status: 'pending' }))
})

// 12. pruneSampleReviews：配置变化 / 内容变化 / 标注离队都失效
check('复核结论在配置变化或标注内容变化后自动失效', () => {
  const anns = [
    ann(0, 2, ['X'], 'a1', { quote: '一', note: '' }),
    ann(2, 4, ['X'], 'a2', { quote: '二', note: '' }),
  ]
  const cfg = makeSamplingConfig([{ tag: 'X', count: 2 }], 's')!
  const plan = buildSamplingPlan(cfg, anns)
  const [i1, i2] = plan.queue
  const reviews: SampleReview[] = [
    {
      configKey: plan.configKey,
      annotationId: i1.annotationId,
      signature: i1.signature,
      verdict: 'pass',
      note: 'ok',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      configKey: plan.configKey,
      annotationId: i2.annotationId,
      signature: 'stale-sig',
      verdict: 'return',
      note: '',
      createdAt: 2,
      updatedAt: 2,
    },
    {
      configKey: 'other-config-key',
      annotationId: i1.annotationId,
      signature: i1.signature,
      verdict: 'pass',
      note: '',
      createdAt: 3,
      updatedAt: 3,
    },
  ]
  const kept = pruneSampleReviews(reviews, plan)
  assert.strictEqual(kept.length, 1)
  assert.strictEqual(kept[0].annotationId, i1.annotationId)

  // 标注内容变化 → 签名不命中 → 失效
  const changed = anns.map((a) =>
    a.id === i1.annotationId ? { ...a, note: '编辑过备注' } : a,
  )
  const plan2 = buildSamplingPlan(cfg, changed)
  assert.strictEqual(pruneSampleReviews(reviews, plan2).length, 0)

  // 标注删除 → 离队 → 失效
  const plan3 = buildSamplingPlan(cfg, anns.filter((a) => a.id !== i1.annotationId))
  assert.strictEqual(pruneSampleReviews(reviews, plan3).length, 0)
})

// 13. 配置键：只取决于配额与种子，与创建时间无关；配额顺序无关
check('配置键与创建时间无关、与配额书写顺序无关', () => {
  const k1 = samplingConfigKey(
    [
      { tag: 'X', count: 2 },
      { tag: 'Y', count: 1 },
    ],
    'seed',
  )
  const k2 = samplingConfigKey(
    [
      { tag: 'Y', count: 1 },
      { tag: 'X', count: 2 },
    ],
    'seed',
  )
  assert.strictEqual(k1, k2)
  const k3 = samplingConfigKey([{ tag: 'X', count: 3 }], 'seed')
  assert.notStrictEqual(k1, k3)
  const k4 = samplingConfigKey([{ tag: 'X', count: 2 }], 'seed2')
  assert.notStrictEqual(k1, k4)
  // 不同创建时间的配置生成同一队列
  const c1 = makeSamplingConfig([{ tag: 'X', count: 2 }], 's')!
  const c2 = makeSamplingConfig([{ tag: 'X', count: 2 }], 's')!
  const anns = [ann(0, 1, ['X'], 'z1'), ann(1, 2, ['X'], 'z2')]
  assert.strictEqual(buildSamplingPlan(c1, anns).configKey, buildSamplingPlan(c2, anns).configKey)
})

// 14. makeSamplingConfig / normalize：非法与脏数据
check('配额归一化：标签清洗、正整数、同名取最大', () => {
  const cfg = makeSamplingConfig(
    [
      { tag: ' #X ', count: 2 },
      { tag: 'X', count: 5 },
      { tag: '', count: 3 },
      { tag: 'Y', count: 0 },
      { tag: 'Z', count: 2.9 },
    ],
    '  seed  ',
  )!
  assert.deepStrictEqual(
    cfg.quotas.map((q) => [q.tag, q.count]),
    [
      ['X', 5],
      ['Z', 2],
    ],
  )
  assert.strictEqual(cfg.seed, '  seed  ')
  assert.strictEqual(makeSamplingConfig([{ tag: 'X', count: 0 }], 's'), null)
})

check('normalizeSamplingConfig 兼容旧数据与脏数据', () => {
  assert.strictEqual(normalizeSamplingConfig(undefined), null)
  assert.strictEqual(normalizeSamplingConfig(null), null)
  assert.strictEqual(normalizeSamplingConfig({}), null)
  assert.strictEqual(normalizeSamplingConfig({ quotas: [], seed: 's' }), null)
  const cfg = normalizeSamplingConfig({
    quotas: [{ tag: '#甲', count: 3 }],
    seed: 's',
    createdAt: '2026-09-18T00:00:00.000Z',
  })!
  assert.strictEqual(cfg.quotas[0].tag, '甲')
  assert.ok(cfg.createdAt > 0)
})

check('normalizeSampleReviews：非数组→空；缺字段/非法结论丢弃；同键去重', () => {
  assert.deepStrictEqual(normalizeSampleReviews(undefined), [])
  const out = normalizeSampleReviews([
    {
      configKey: 'k',
      annotationId: 'a1',
      signature: 'sig',
      verdict: 'pass',
      note: 'n',
      createdAt: 1,
      updatedAt: 2,
    },
    { configKey: 'k', annotationId: 'a1', signature: 'sig2', verdict: 'return' }, // 同键去重
    { configKey: '', annotationId: 'a2', signature: 's', verdict: 'pass' }, // 缺 configKey
    { configKey: 'k', annotationId: 'a3', signature: 's', verdict: 'weird' }, // 非法 verdict
  ])
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].verdict, 'pass')
  assert.strictEqual(out[0].note, 'n')
  assert.strictEqual(out[0].updatedAt, 2)
})

// 15. 复核记录键
check('sampleReviewKey 由配置键与标注 ID 组成', () => {
  assert.strictEqual(sampleReviewKey('k', 'a1'), 'k a1')
})

console.log(`\nsampling：${passed} 项断言全部通过`)
