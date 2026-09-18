import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import type {
  Annotation,
  SampleReview,
  SampleVerdict,
  SamplingConfig,
} from '../types'
import {
  sampleReviewKey,
  type SamplingPlan,
  type SamplingQuotaInput,
} from '../lib/sampling'
import { badgeColor } from '../lib/segments'

interface Props {
  /** 当前文档实际使用的全部标签（配置用） */
  allTags: string[]
  config: SamplingConfig | null
  plan: SamplingPlan
  reviews: SampleReview[]
  activeId: string | null
  annById: Map<string, Annotation>
  onSaveConfig: (quotas: SamplingQuotaInput[], seed: string) => void
  onClearConfig: () => void
  onSetVerdict: (annotationId: string, verdict: SampleVerdict | null, note: string) => void
  onFocus: (a: Annotation) => void
  /** 抽样复核分区的滚动定位 ref（顶栏按钮用） */
  sectionRef?: RefObject<HTMLElement | null>
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 配置表单：标签点选 + 数量输入 + 种子；本地编辑，提交时才落库 */
function ConfigForm({
  allTags,
  initial,
  onCancel,
  onSave,
}: {
  allTags: string[]
  initial: SamplingConfig | null
  onCancel: () => void
  onSave: (quotas: SamplingQuotaInput[], seed: string) => void
}) {
  // 已加入配置的标签 + 每标签数量（数量为 0 表示待填写，提交时校验）
  const [selected, setSelected] = useState<Map<string, number>>(
    () => new Map((initial?.quotas ?? []).map((q) => [q.tag, q.count])),
  )
  const [customTag, setCustomTag] = useState('')
  const [seed, setSeed] = useState(initial?.seed ?? '')
  const [error, setError] = useState('')

  const tags = [...selected.keys()]

  const toggle = (tag: string) => {
    setError('')
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(tag)) next.delete(tag)
      else next.set(tag, 1)
      return next
    })
  }

  const setCount = (tag: string, raw: string) => {
    const n = Number(raw)
    setSelected((prev) => {
      const next = new Map(prev)
      next.set(tag, Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0)
      return next
    })
  }

  const addCustom = () => {
    const tag = customTag.trim().replace(/^#/, '').trim()
    if (!tag) return
    setError('')
    setSelected((prev) => {
      if (prev.has(tag)) return prev
      const next = new Map(prev)
      next.set(tag, 1)
      return next
    })
    setCustomTag('')
  }

  const submit = () => {
    if (selected.size === 0) {
      setError('请至少选择一个标签并填写抽样数。')
      return
    }
    if (seed.trim() === '') {
      setError('请输入抽样种子：相同的标签、数量与种子会得到完全相同的队列。')
      return
    }
    const bad = tags.find((t) => !selected.get(t))
    if (bad) {
      setError(`标签 #${bad} 的抽样数需为正整数。`)
      return
    }
    onSave(
      tags.map((t) => ({ tag: t, count: selected.get(t)! })),
      seed.trim(),
    )
  }

  return (
    <div className="spl-form">
      <p className="side-hint">
        点选一个或多个标签并填写每标签<strong>抽样数</strong>，再输入<strong>种子</strong>。
        仅从<strong>已绑定</strong>标注中取样：按 <code>SHA-256(种子+标注 ID)</code> 生成稳定顺序，
        逐轮优先选择能补足最多尚缺配额的标注；同一配置始终得到同一队列。
      </p>
      <div className="cov-tagpick">
        {allTags.map((t) => (
          <button
            type="button"
            key={t}
            className={`cov-tag ${selected.has(t) ? 'cov-tag-on' : ''}`}
            aria-pressed={selected.has(t)}
            onClick={() => toggle(t)}
            title={selected.has(t) ? '点击移出抽样标签' : '点击加入抽样标签'}
          >
            #{t}
          </button>
        ))}
        {allTags.length === 0 && (
          <span className="side-hint">文档中还没有标签，可直接在下方填写标签名。</span>
        )}
      </div>
      <div className="spl-custom">
        <input
          className="spl-custom-input"
          value={customTag}
          placeholder="填写其他标签名后回车添加"
          onChange={(e) => setCustomTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addCustom()
            }
          }}
        />
        <button type="button" className="btn btn-small btn-ghost" onClick={addCustom}>
          添加
        </button>
      </div>

      {tags.length > 0 && (
        <div className="spl-quotas">
          {tags.map((t) => (
            <label className="spl-quota-row" key={t}>
              <span className="spl-quota-tag">#{t}</span>
              <input
                className="spl-quota-count"
                type="number"
                min={1}
                step={1}
                value={selected.get(t) ?? ''}
                onChange={(e) => setCount(t, e.target.value)}
              />
              <span className="spl-quota-label">条</span>
            </label>
          ))}
        </div>
      )}

      <label className="spl-seed-row">
        <span className="spl-seed-label">种子</span>
        <input
          className="spl-seed-input"
          value={seed}
          placeholder="如 2026-质检-Q3（任意文本）"
          onChange={(e) => {
            setSeed(e.target.value)
            setError('')
          }}
        />
      </label>

      {error && <p className="spl-error">{error}</p>}

      <div className="spl-form-actions">
        {initial && (
          <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>
            取消
          </button>
        )}
        <span className="form-spacer" />
        <button type="button" className="btn btn-small btn-primary" onClick={submit}>
          {initial ? '更新配置并生成队列' : '生成抽样队列'}
        </button>
      </div>
    </div>
  )
}

/** 单条抽中项卡片：引文、命中标签、哈希；可标记通过 / 退回并填写复核备注 */
function SampleCard({
  item,
  review,
  active,
  ann,
  onFocus,
  onSetVerdict,
}: {
  item: SamplingPlan['queue'][number]
  review: SampleReview | null
  active: boolean
  ann: Annotation | undefined
  onFocus: (a: Annotation) => void
  onSetVerdict: (annotationId: string, verdict: SampleVerdict | null, note: string) => void
}) {
  const [note, setNote] = useState(review?.note ?? '')
  // 切换到另一条抽中项（或结论被外部清空）时，用记录中的备注同步输入框
  useEffect(() => {
    setNote(review?.note ?? '')
  }, [review?.note, item.annotationId])

  if (!ann) return null
  const verdict = review?.verdict ?? null

  const choose = (v: SampleVerdict) => {
    // 再次点击当前结论 = 清除该结论
    onSetVerdict(item.annotationId, verdict === v ? null : v, note)
  }

  return (
    <div
      className={`spl-item ${verdict === 'pass' ? 'spl-pass' : ''} ${
        verdict === 'return' ? 'spl-return' : ''
      } ${active ? 'spl-active' : ''}`}
    >
      <div className="spl-head">
        <span className="ann-badge" style={{ backgroundColor: badgeColor(ann.id) }} />
        <button
          type="button"
          className="spl-quote"
          title="在原文中定位"
          onClick={() => onFocus(ann)}
        >
          {ann.quote || <span className="ann-empty-quote">（空引文）</span>}
        </button>
      </div>
      <div className="spl-meta">
        <span className="spl-tags">
          {item.matchedTags.map((t) => (
            <span className="ann-tag" key={t}>
              #{t}
            </span>
          ))}
        </span>
        <span className="spl-hash" title={item.hash}>
          哈希 {item.hash.slice(0, 8)}
        </span>
      </div>
      <textarea
        className="spl-note"
        rows={2}
        placeholder="复核备注（退回原因 / 通过说明）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          // 已有结论时失焦即保存备注；尚无结论时备注先留在本地，随结论一起落库
          if (verdict && note !== review?.note) {
            onSetVerdict(item.annotationId, verdict, note)
          }
        }}
      />
      {review && (
        <p className="spl-reviewed-at">
          {review.verdict === 'pass' ? '已通过' : '已退回'} · {formatTime(review.updatedAt)}
        </p>
      )}
      <div className="spl-actions">
        <button className="btn btn-small btn-ghost" onClick={() => onFocus(ann)}>
          定位
        </button>
        <span className="form-spacer" />
        <button
          type="button"
          className={`btn btn-small ${verdict === 'return' ? 'spl-btn-return-on' : 'btn-ghost'}`}
          aria-pressed={verdict === 'return'}
          onClick={() => choose('return')}
        >
          退回
        </button>
        <button
          type="button"
          className={`btn btn-small ${verdict === 'pass' ? 'spl-btn-pass-on' : 'btn-primary'}`}
          aria-pressed={verdict === 'pass'}
          onClick={() => choose('pass')}
        >
          通过
        </button>
      </div>
    </div>
  )
}

/** 抽样复核侧栏分区 */
export function SamplingSection(props: Props) {
  const { config, plan, reviews } = props
  const [editing, setEditing] = useState(false)
  const reviewByKey = new Map(
    reviews.map((r) => [sampleReviewKey(r.configKey, r.annotationId), r]),
  )

  const reviewedCount = plan.queue.filter((item) =>
    reviewByKey.has(sampleReviewKey(plan.configKey, item.annotationId)),
  ).length
  const passCount = plan.queue.filter(
    (item) =>
      reviewByKey.get(sampleReviewKey(plan.configKey, item.annotationId))?.verdict === 'pass',
  ).length
  const returnCount = reviewedCount - passCount
  const pending = plan.queue.length - reviewedCount
  const gapTotal = plan.tags.reduce((sum, t) => sum + t.gap, 0)

  return (
    <section
      className="side-section"
      ref={(props.sectionRef as React.Ref<HTMLElement>) ?? undefined}
    >
      <h2 className={`side-heading ${pending > 0 ? 'side-heading-sampling' : ''}`}>
        抽样复核
        {pending > 0 && <span className="conflict-count-badge sampling-count-badge">{pending}</span>}
      </h2>

      {!config || editing ? (
        <ConfigForm
          allTags={props.allTags}
          initial={config}
          onCancel={() => setEditing(false)}
          onSave={(quotas, seed) => {
            props.onSaveConfig(quotas, seed)
            setEditing(false)
          }}
        />
      ) : (
        <>
          <p className="side-hint">
            种子 <code>{plan.seed || '（空）'}</code> · 候选 {plan.candidateCount} 条 ·
            中选 {plan.queue.length} 条。相同的标签配额与种子在相同标注集上<strong>必然生成相同队列</strong>；
            结论绑定标注 ID 与内容签名，标注内容变化后自动失效。
          </p>
          <div className="spl-toolbar">
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(true)}>
              修改配置
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost btn-danger-text"
              onClick={() => {
                if (confirm('清除抽样配置将同时移除队列与全部复核结论。是否继续？')) {
                  props.onClearConfig()
                }
              }}
            >
              清除配置
            </button>
          </div>

          <table className="spl-table">
            <thead>
              <tr>
                <th>标签</th>
                <th className="spl-num">目标</th>
                <th className="spl-num">实际</th>
                <th className="spl-num">缺口</th>
              </tr>
            </thead>
            <tbody>
              {plan.tags.map((t) => (
                <tr key={t.tag} className={t.gap > 0 ? 'spl-row-gap' : ''}>
                  <td className="spl-cell-tag">#{t.tag}</td>
                  <td className="spl-num">{t.target}</td>
                  <td className="spl-num">{t.actual}</td>
                  <td className="spl-num" title={`已绑定候选池共 ${t.pool} 条`}>
                    {t.gap > 0 ? <strong>{t.gap}</strong> : '✓'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {gapTotal > 0 && (
            <p className="spl-gap-hint">
              共 {gapTotal} 个配额缺口：已绑定候选不足，队列在候选耗尽后终止（标签列已标注候选池大小）。
            </p>
          )}

          <div className="spl-summary">
            <span>
              待复核 <strong>{pending}</strong>
            </span>
            <span className="spl-summary-pass">
              通过 <strong>{passCount}</strong>
            </span>
            <span className="spl-summary-return">
              退回 <strong>{returnCount}</strong>
            </span>
          </div>

          {plan.queue.length === 0 ? (
            <p className="side-hint">
              已绑定标注中没有命中所选标签的候选，请先完成标注绑定或调整配置。
            </p>
          ) : (
            plan.queue.map((item) => (
              <SampleCard
                key={item.annotationId}
                item={item}
                review={reviewByKey.get(sampleReviewKey(plan.configKey, item.annotationId)) ?? null}
                active={props.activeId === item.annotationId}
                ann={props.annById.get(item.annotationId)}
                onFocus={props.onFocus}
                onSetVerdict={props.onSetVerdict}
              />
            ))
          )}
        </>
      )}
    </section>
  )
}
