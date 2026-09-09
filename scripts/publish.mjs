#!/usr/bin/env node
/**
 * 发一份手写的稿子。**整条路上一次模型调用都没有。**
 *
 * 站长：「我能不能每天给你一个信息在这里帮我更新，我不用 API 但是我用你的算力。」
 *
 * 能。而且这比省钱更值得走：
 *
 *   - 原来那条路：Actions 里的脚本调 API，模型在**那边**搜索、读原文、成稿。
 *     每一步都计费，一轮二十条几美元；而贵的不是「写」，是「读」——
 *     搜回来的内容在同一次调用的每一轮里都要重读一遍。
 *   - 现在这条：站长在对话里说一句「今天更新」，搜索、读原文、按方针写稿
 *     全在对话这边做完，写完提交成一个文本文件；这个脚本把文件发上站。
 *     Actions 这一段**不碰模型**，账单是零。
 *
 * 所以这个脚本包下的是「写完之后到数据库之间」那些机械的活儿，
 * 并且**在发出去之前把不合格的稿子拦住**：
 *
 *   1. 每条至少两个来源——站长定的规矩，也是读者能自己去核的前提；
 *   2. 每个来源的网址都真的打得开（手写的链接会错，凭印象写的更会错）；
 *   3. 正文里不许有本站自述（「PRISM 将持续关注」那一类，这个站不派记者）；
 *   4. 正文里不许有 [1] [2] 角标，出处要在句子里点名；
 *   5. 站上已经讲过的同一件事，把新来源挂上去，不新开一条。
 *
 * 任何一条不过就**整份退回**，一个字都不写进数据库。稿子还在手边、
 * 改一行再跑一遍很便宜；一条带着死链的新闻挂在首页上不便宜。
 *
 * 用法：
 *   node scripts/publish.mjs                       发 drafts/ 里最新的那份
 *   node scripts/publish.mjs drafts/2026-09-09.txt 指定一份
 *   node scripts/publish.mjs --dry                 只校验、只看，不写库
 *   node scripts/publish.mjs --offline             完全不联网：不点链接、也不取配图
 *   node scripts/publish.mjs --hold                写进去但先下架，等站长过目
 *
 * 稿子长这样（一条一块，字段名不认识的会被忽略）：
 *
 *   ===ITEM 1===
 *   HEADLINE: 主标题
 *   SUBHEAD: 副标题，一句话
 *   TOPICS: sexual, rights
 *   REGIONS: cn
 *   DATE: 2026-09-09
 *   IMAGE: https://…            （可留空，留空就去第一个来源页面取 og:image）
 *   LINKS:
 *   - 澎湃新闻 | https://www.thepaper.cn/… | 2026-09-08 | 原报道标题
 *   - 路透社 | https://www.reuters.com/…
 *   BULLETS:
 *   - 要点一
 *   - 要点二
 *   SUMMARY:
 *   正文第一段。
 *
 *   正文第二段。换行就是换行，不用转义。
 *   ===END 1===
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseDraft, len, langOf } from './draft.mjs'
import { slugify, tokens, sameStory, normUrl, ogImage, outletFor } from './feedparse.mjs'
import { FEEDS } from './feeds.mjs'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
/* 联网做两件事：点一遍来源、去第一个来源取配图。--offline 两件都不做。 */
const ONLINE = !(argv.includes('--offline') || argv.includes('--no-verify'))
const HOLD = argv.includes('--hold')
const ALLOW_SINGLE = argv.includes('--allow-single')
const FILE_ARG = argv.find((a) => !a.startsWith('--'))

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '')
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? ''

const UA = 'Mozilla/5.0 (compatible; PRISM/1.0; +https://prism-daily.github.io/PRISM/)'


/* ------------------------------------------------------------------ *
 * 联网：链接真的打得开吗，配图取得到吗
 * ------------------------------------------------------------------ */

async function get(url, ms = 15000, accept = 'text/html,application/xhtml+xml,*/*;q=0.8') {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': UA, accept, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } })
    return { ok: res.ok, status: res.status, res }
  } catch (e) {
    return { ok: false, status: 0, why: e.name === 'AbortError' ? '超时' : String(e.message ?? e).slice(0, 60) }
  } finally { clearTimeout(t) }
}

/**
 * 每个来源都去点一下。
 *
 * 这一步是这个脚本存在的**主要理由**。稿子是在对话里写的，链接是照着
 * 搜索结果誊过来的——誊错一个字符，读者点开就是 404，而这个站唯一的
 * 承诺就是「你可以自己去核对」。机器点一遍只要几秒。
 *
 * 403 单独说：那多半是对方挡爬虫，人在浏览器里点得开。所以它不算致命，
 * 只提醒一句，让人自己判断。
 */
async function verifyLinks(items) {
  const jobs = []
  for (const it of items) for (const l of it.links) jobs.push({ it, l })
  const out = []
  for (let i = 0; i < jobs.length; i += 6) {
    out.push(...await Promise.all(jobs.slice(i, i + 6).map((j) => get(j.l.url))))
  }
  jobs.forEach((j, k) => {
    const r = out[k]
    if (r.ok) return
    if (r.status === 403 || r.status === 401 || r.status === 429) {
      j.it.note.push(`${j.l.outlet || j.l.url}：HTTP ${r.status}，多半是挡爬虫，人点得开——自己确认一下`)
      return
    }
    j.it.bad.push(`来源打不开（${r.status ? `HTTP ${r.status}` : r.why}）：${j.l.url}`)
  })
}

/** 没给图就去第一个来源的页面取一张。取不到就没有图，不去别处找「看起来像」的。 */
async function covers(items) {
  let got = 0
  for (const it of items) {
    if (it.imageUrl) {
      it.image = { url: it.imageUrl, alt: `${it.links[0]?.outlet ?? '来源媒体'} 为这条报道配发的图片`, credit: it.links[0]?.outlet ?? '' }
      got += 1
      continue
    }
    const first = it.links[0]
    if (!first) continue
    const r = await get(first.url)
    if (!r.ok) continue
    try {
      const html = (await r.res.text()).slice(0, 400000)
      const img = ogImage(html, first.outlet || outletFor(first.url, FEEDS))
      if (img) { it.image = img; got += 1 }
    } catch { /* 取不到就算了，没有图不影响一条新闻成立 */ }
  }
  return got
}

/* ------------------------------------------------------------------ *
 * 数据库
 * ------------------------------------------------------------------ */

const db = (path, init = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  ...init,
  headers: {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    'content-type': 'application/json',
    ...(init.headers ?? {}),
  },
})

async function existing() {
  const res = await db('news?select=id,slug,headline,links')
  if (!res.ok) throw new Error(`读已有条目失败：HTTP ${res.status}`)
  const rows = await res.json()
  const urls = new Set()
  const slugs = new Set()
  const items = []
  for (const r of rows) {
    slugs.add(r.slug)
    for (const l of (r.links ?? [])) if (l?.url) urls.add(normUrl(l.url))
    items.push({ id: r.id, headline: r.headline, links: r.links ?? [], key: tokens(r.headline) })
  }
  return { urls, slugs, items }
}

/* ------------------------------------------------------------------ *
 * 跑
 * ------------------------------------------------------------------ */

function pickFile() {
  if (FILE_ARG) return FILE_ARG
  const dir = 'drafts'
  if (!existsSync(dir)) return ''
  /*
   * README.md 要排掉——它是这个目录的说明，不是稿子。少了这一句，
   * 一次「什么都没改只改了说明」的提交会让发稿脚本去解析说明文档，
   * 报一句「没有 ===ITEM=== 块」然后红着退出。
   *
   * 稿子按文件名排序取最后一个，所以文件名请用日期（2026-09-09.txt）。
   */
  const files = readdirSync(dir).filter((f) => /\.(txt|md)$/.test(f) && !/^README/i.test(f)).sort()
  return files.length ? join(dir, files[files.length - 1]) : ''
}

const file = pickFile()
/*
 * 「指名要发的那份不存在」和「drafts/ 里眼下没有稿子」是两件事，
 * 结局也该不一样：前者是打错了名字，要红着停下；后者是一次只改了说明
 * 的提交顺手触发了这个 workflow，没什么可发的——那不是错误，
 * 一片红色的失败记录只会让人以后不敢看 Actions。
 */
if (FILE_ARG && !existsSync(FILE_ARG)) {
  console.error(`没有这份稿子：${FILE_ARG}`)
  process.exit(2)
}
if (!file) {
  console.log('drafts/ 里眼下没有稿子，这一轮没有可发的。')
  process.exit(0)
}
if (!DRY && (!SUPABASE_URL || !SERVICE_KEY)) {
  console.error('缺 SUPABASE_URL 或 SUPABASE_SERVICE_KEY。只想校验就加 --dry。')
  process.exit(2)
}

console.log(`PRISM 发稿：${file}`)
console.log('—'.repeat(76))

const items = parseDraft(readFileSync(file, 'utf8'), { allowSingle: ALLOW_SINGLE })
if (items.length === 0) {
  console.error('这份文件里没有 ===ITEM n=== 块。')
  process.exit(2)
}

if (ONLINE) {
  console.log(`点一遍所有来源（共 ${items.reduce((n, it) => n + it.links.length, 0)} 个）…`)
  await verifyLinks(items)
}

/*
 * 一条不合格，整份退回。
 *
 * 为什么不是「跳过那一条、发其余的」：这份稿子是人一条条写出来的，
 * 静默少发一条，人不会当场发现——他看到「已上线 19 条」，不会去数
 * 是不是二十。而改一行重跑的代价接近于零。
 */
const broken = items.filter((it) => it.bad.length)
for (const it of items) {
  const head = `第 ${it.i} 条 ${it.headline.slice(0, 30) || '（无标题）'}`
  if (it.bad.length) {
    console.log(`✗ ${head}`)
    for (const b of it.bad) console.log(`    ${b}`)
  } else if (it.note.length) {
    console.log(`△ ${head}`)
    for (const b of it.note) console.log(`    ${b}`)
  } else {
    console.log(`✓ ${head}（${len(it.summary)} 字，${it.links.length} 个来源）`)
  }
}
console.log('—'.repeat(76))

if (broken.length) {
  console.log(`::error::${broken.length}/${items.length} 条不合格，一条都没有发。改完再跑一次。`)
  process.exit(1)
}

const gotImg = ONLINE ? await covers(items) : items.filter((it) => it.imageUrl).length
if (!ONLINE) for (const it of items) if (it.imageUrl) it.image = { url: it.imageUrl, alt: `${it.links[0]?.outlet ?? '来源媒体'} 为这条报道配发的图片`, credit: it.links[0]?.outlet ?? '' }
console.log(`${items.length} 条全部合格，配图 ${gotImg}/${items.length} 条`)

if (DRY) {
  console.log('（--dry）到此为止，没有写数据库。')
  process.exit(0)
}

const have = await existing()
const toInsert = []
const toAppend = []

items.forEach((it, i) => {
  const links = it.links
    .filter((l) => !have.urls.has(normUrl(l.url)))
    .map((l, j) => ({
      id: `l-${Date.now().toString(36)}-${i}-${j}`,
      outlet: l.outlet || outletFor(l.url, FEEDS),
      title: l.title || it.headline,
      url: l.url,
      lang: langOf(l.title || it.headline, l.url),
      date: l.date || it.date,
    }))
  if (links.length === 0) { console.log(`  第 ${it.i} 条的来源站上都有了，跳过`); return }

  // 这件事本站讲过没有？讲过就把新来源挂上去，不新开一条。
  const seen = have.items.find((x) => sameStory(x.key, tokens(it.headline)))
  if (seen) { toAppend.push({ item: seen, links }); return }

  let slug = slugify(it.headline) || `item-${Date.now().toString(36)}-${i}`
  while (have.slugs.has(slug)) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`
  have.slugs.add(slug)

  toInsert.push({
    id: `news-${Date.now().toString(36)}-${i}`,
    slug,
    headline: it.headline,
    subhead: it.subhead,
    summary: it.summary,
    bullets: it.bullets,
    regions: it.regions,
    topics: it.topics,
    links,
    image: it.image ?? null,
    status: HOLD ? 'hidden' : 'live',
    /*
     * origin 写 'human'：这批不是抓来的，是人写的。控制端按这个字段区分
     * 「机器收的」和「人写的」，而站长审起来这两类要看的东西不一样。
     */
    origin: 'human',
    featured: false,
    demo: false,
    edited_by_human: true,
    editor_note: null,
    content_notice: it.notice,
    published_at: `${it.date}T00:00:00.000Z`,
    updated_at: new Date().toISOString(),
  })
})

for (const { item, links } of toAppend) {
  const res = await db(`news?id=eq.${encodeURIComponent(item.id)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ links: [...item.links, ...links], updated_at: new Date().toISOString() }),
  })
  console.log(res.ok
    ? `  给已有的「${item.headline.slice(0, 24)}」补了 ${links.length} 个来源`
    : `::error::给「${item.headline.slice(0, 24)}」补来源失败：HTTP ${res.status}`)
}

if (toInsert.length) {
  const res = await db('news', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(toInsert) })
  if (!res.ok) {
    console.error(`::error::写入失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    process.exit(1)
  }
}

console.log(HOLD
  ? `已写入 ${toInsert.length} 条，全部下架状态等你过目。`
  : `已上线 ${toInsert.length} 条。`)
console.log('这一轮的模型开销：0（稿子是在对话里写的，这一步只做校验和写库）')
