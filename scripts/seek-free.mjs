/**
 * 按关键词找选题——**不花钱的那一条路**。
 *
 * 站长：「我有没有办法在网站的搜索上是免费的。」有。
 *
 * 现在这一步是让模型用它的服务端搜索工具去搜：每次搜索一美分，而真正贵的
 * 是搜回来的内容在同一次调用的每一轮里都要重读一遍——实测一轮 21 次搜索
 * 花掉 3.35 美元。
 *
 * 而新闻搜索本身有免费的机读接口：Google News 和 Bing News 都提供
 * 「按关键词查询」的 RSS，无 key、无注册、无限额。返回的就是真实报道的
 * 标题、链接、媒体名和日期——正好是这条流水线要的东西。
 *
 * 所以这个模块做的事：拿一组关键词，去这两个引擎各查一遍，把结果变成
 * 和 RSS 条目形状一样的候选，往下走同一条流水线（抓原文 → 合并 → 写稿）。
 * **整个过程一次模型调用都没有，成本为零。**
 *
 * 代价要说清楚，不然这就是个骗人的「免费」：
 *
 *   - 模型搜索会**读**搜索结果、判断哪几条真的符合题目；关键词搜索不会，
 *     它只按字面匹配。所以召回里杂质更多——但下一步的初筛本来就要过一遍
 *     模型，杂质在那里被刷掉，而初筛是按条计费的短输出，便宜得多。
 *   - 关键词要人来想。模型能把「内地的性骚扰案件」自己展开成十几种问法，
 *     这里得把问法写出来。所以下面备了一份默认词表。
 *   - Google News 的链接是跳转链接，要跟一次重定向才拿到媒体自己的地址。
 *     不解析的话，读者点开看到的是 news.google.com，而「来源」那一栏
 *     写的是这个站最看重的东西。
 */
import { parseFeed, outletFor, registrableHost } from './feedparse.mjs'

/** 两个引擎。都不要 key。 */
const ENGINES = [
  {
    id: 'google',
    /*
     * hl / gl / ceid 决定用哪个语言和地区的索引。中文查询用简体中国的索引，
     * 英文查询用美国的——同一个词在两个索引里返回的东西差别很大。
     */
    url: (q, zh) => (zh
      ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`
      : `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`),
  },
  {
    id: 'bing',
    url: (q, zh) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS`
      + (zh ? '&setmkt=zh-CN' : '&setmkt=en-US'),
  },
]

const UA = 'Mozilla/5.0 (compatible; PRISM/1.0; +https://prism-daily.github.io/PRISM/)'
const hasCjk = (s) => /[一-鿿]/.test(s)

async function getText(url, ms = 20000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: ctl.signal })
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
    return { ok: true, text: await res.text() }
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) }
  } finally { clearTimeout(t) }
}

/**
 * 把 Google News 的跳转链接还原成媒体自己的地址。
 *
 * 不还原的话，读者点「来源」看到的是 news.google.com——而来源链接是这个站
 * 最看重的东西（「你可以自己去核对」）。跟一次重定向，读 `res.url`。
 * 跟不动就退回 `<source url>` 给的域名首页：那至少说明是哪家媒体，
 * 比一个聚合器的地址诚实。
 */
export async function resolveLink(link, sourceUrl, ms = 15000) {
  if (!/news\.google\.com|bing\.com/.test(link)) return link
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(link, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctl.signal })
    if (res.url && !/news\.google\.com|bing\.com/.test(res.url)) return res.url
    /*
     * Google 有时候回的是一个用 JS 跳转的中间页，`res.url` 还停在 google 上。
     * 那种页面里有一条指向真实地址的链接，捞第一条不是 google 的。
     */
    const html = await res.text()
    const m = html.match(/https?:\/\/(?!(?:\w+\.)?(?:google|gstatic|bing)\.com)[^"'\s<>\\]{16,}/)
    if (m) return m[0].replace(/&amp;/g, '&')
  } catch { /* 跟不动就用下面的退路 */ } finally { clearTimeout(t) }
  return sourceUrl || link
}

/**
 * 一组关键词 → 一批候选。
 *
 * @param queries 关键词数组。中文和英文混着写没关系，语言按每一条自己判断。
 * @param want    想要几条（只用来定上限，不会为了凑数放宽筛选）。
 * @param feeds   订阅清单，给认不出的域名配一个像样的媒体名。
 */
export async function seekFree(queries, want, feeds = []) {
  const seen = new Set()
  const out = []
  const log = []

  for (const q of queries) {
    const zh = hasCjk(q)
    for (const eng of ENGINES) {
      if (out.length >= want * 4) break
      const got = await getText(eng.url(q, zh))
      if (!got.ok) { log.push(`  ${eng.id}「${q}」拿不到：${got.why}`); continue }
      const items = parseFeed(got.text)
      log.push(`  ${eng.id}「${q}」${items.length} 条`)

      for (const e of items) {
        const link = await resolveLink(e.link, e.source?.url)
        const key = registrableHost(link) + '|' + e.title.replace(/\s+/g, '').slice(0, 30)
        if (seen.has(key)) continue
        seen.add(key)

        const when = Date.parse(e.date ?? '')
        out.push({
          feed: {
            id: 'seek-free',
            outlet: e.source?.name || outletFor(link, feeds),
            major: false,
            /*
             * `topical: true`：这一条是**按关键词查出来的**，已经过了一次
             * 字面筛选，不该再被 topicsOf 的关键词那一关刷掉一次。
             * 真正的判断交给下一步的初筛——那一步模型会读标题和摘要。
             */
            topical: true,
            regions: [],
          },
          title: e.title,
          link,
          summary: e.summary ?? '',
          topics: [],
          regions: [],
          at: Number.isFinite(when) ? new Date(when).toISOString() : new Date().toISOString(),
          seeked: true,
        })
      }
    }
  }
  return { items: out, log }
}

/**
 * 把一段中文题目拆成关键词。
 *
 * 站长在 workflow 上填的是一段话或者几行词。一行一条、顿号分隔、分号分隔
 * 都当分隔符；太短的（两个字以下）丢掉，那种词搜出来全是噪音。
 */
export function toQueries(brief) {
  return String(brief ?? '')
    .split(/[\n；;、]+/)
    .map((s) => s.replace(/^[（(]\d+[)）]\s*/, '').replace(/[。，,]+$/, '').trim())
    .filter((s) => s.length >= 3)
}
