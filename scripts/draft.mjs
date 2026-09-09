/**
 * 手写稿的解析与校验——**纯函数，不联网、不写库**。
 *
 * 和 scripts/publish.mjs 分开，是为了这些规矩能被测试直接调用：
 * 「来源少于两个要拦住」「正文里的本站自述要拦住」这几条是站长反复交代过的，
 * 它们值得有测试盯着，而测试没法 import 一个一加载就去读文件、
 * 读不到就 process.exit 的脚本。
 *
 * 格式见 drafts/README.md。
 */
import { splitBlocks, parseBlock, parseList, parseEnum } from './blocks.mjs'
import { TOPICS, REGIONS, REGION_ALIAS } from './taxonomy.mjs'
import { stripSelfVoice, isSelfVoice, cleanLine } from './voice.mjs'

export const FIELDS = ['HEADLINE', 'SUBHEAD', 'TOPICS', 'REGIONS', 'DATE', 'IMAGE', 'NOTICE', 'LINKS', 'BULLETS', 'SUMMARY']

/** 正文字数按「去掉空白之后」算——中文稿子里空格和换行不该算进篇幅。 */
export const len = (t) => String(t ?? '').replace(/\s+/g, '').length

/** 北京时间的今天。站长在北京时间里生活，日期就按那边算。 */
export function todayBeijing() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
}

/** 中英文各按各的标：正文是中文，但来源可能是任何一家。 */
export const langOf = (title, url) => (/[\u4e00-\u9fff]/.test(String(title)) || /\.(cn|hk|tw)(\/|$)/.test(url) ? 'zh' : 'en')

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * `- 媒体名 | 网址 | 日期 | 原标题` —— 除了网址，别的都可以省。
 *
 * 不按位置认字段，按长相认：哪一段是 http 开头的就是网址，哪一段长得像
 * 日期就是日期。手写的时候顺序难免会乱，为这个丢掉一个来源不值得。
 */
export function parseLinks(value) {
  return parseList(value).map((line) => {
    const parts = line.split('|').map((s) => s.trim()).filter(Boolean)
    const url = parts.find((p) => /^https?:\/\//i.test(p)) ?? ''
    const rest = parts.filter((p) => p !== url)
    const date = rest.find((p) => /^\d{4}-\d{2}-\d{2}$/.test(p)) ?? ''
    const left = rest.filter((p) => p !== date)
    return { outlet: left[0] ?? '', url, date, title: left.slice(1).join(' | ') }
  }).filter((l) => l.url || l.outlet)
}

/**
 * 正文里哪几句是「本站自述」。
 *
 * voice.mjs 的 stripSelfVoice 会**直接删掉**这些句子。删得对，但删得安静——
 * 手写稿这条路上，我更想知道是哪一句：删掉一句之后，前一句末尾的「因此」
 * 可能就悬在那里了，改写比删掉好。所以这里把它们找出来报给人看。
 */
export function selfVoiceHits(text) {
  return String(text ?? '')
    .split(/(?<=[。！？])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s && isSelfVoice(s))
}

/**
 * 一个块 → 一条待发的新闻，外加一张「哪里不合格」的清单。
 *
 * 不合格的不在这里丢掉。全部收齐一起报——一次跑出来所有问题，
 * 比改一个跑一次、再冒出下一个要省事得多。
 */
export function shape(raw, i, { allowSingle = false } = {}) {
  const bad = []
  const note = []

  const headline = String(raw.HEADLINE ?? '').trim()
  if (!headline) bad.push('没有标题')
  if (headline.length > 48) note.push(`标题 ${headline.length} 字，首页卡片上会被截断`)

  const rawSummary = String(raw.SUMMARY ?? '').trim()
  const hits = selfVoiceHits(rawSummary)
  for (const h of hits) bad.push(`正文里有本站自述，改写或删掉这一句：「${h.slice(0, 40)}」`)
  const summary = stripSelfVoice(rawSummary)

  const n = len(summary)
  if (n < 400) bad.push(`正文只有 ${n} 字——太短就是没写`)
  if (n > 3000) bad.push(`正文 ${n} 字，超过 3000 字上限`)

  if (/\[\d{1,2}\]/.test(summary)) bad.push('正文里有 [1] 这种角标——出处要在句子里点名（据《卫报》报道…）')

  const topics = parseEnum(raw.TOPICS, TOPICS)
  if (topics.length === 0) bad.push(`议题不认识或没填（TOPICS: ${String(raw.TOPICS ?? '').slice(0, 40)}）`)
  const regions = parseEnum(raw.REGIONS, REGIONS, REGION_ALIAS)
  if (regions.length === 0) bad.push(`地区不认识或没填（REGIONS: ${String(raw.REGIONS ?? '').slice(0, 40)}）`)

  const links = parseLinks(raw.LINKS)
  for (const l of links) {
    if (!/^https?:\/\//i.test(l.url)) bad.push(`来源不是一个网址：${l.url || l.outlet}`)
    if (/\.invalid(\/|$)/.test(l.url)) bad.push(`来源是假域名：${l.url}`)
  }
  /*
   * 两个来源这条规矩是站长定的，理由他也说过：一件事有两家独立报道过，
   * 读者才好核。它不是形式——上一轮内地那批里有九条只有一个来源，
   * 那九条现在还欠着。所以这里拦住，而不是记一笔以后再说。
   */
  if (links.length < 2 && !allowSingle) {
    bad.push(`只有 ${links.length} 个来源，站长定的是两个起（真的只有一家报道，加 --allow-single）`)
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.DATE ?? '').trim())
    ? String(raw.DATE).trim() : todayBeijing()

  return {
    i,
    headline,
    subhead: cleanLine(String(raw.SUBHEAD ?? '').trim()) || null,
    summary,
    bullets: parseList(raw.BULLETS).map(cleanLine).filter(Boolean).slice(0, 6),
    topics,
    regions,
    links,
    imageUrl: String(raw.IMAGE ?? '').trim(),
    notice: String(raw.NOTICE ?? '').trim() || null,
    date,
    bad,
    note,
  }
}

export function parseDraft(text, opts = {}) {
  const blocks = splitBlocks(text)
  return blocks.map((b, k) => shape(parseBlock(b.body, FIELDS), b.i ?? k, opts))
}
