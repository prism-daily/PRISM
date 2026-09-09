/**
 * feed 解析与归类——纯函数，不碰网络也不碰数据库，所以能被测。
 *
 * 单独放一个文件是有原因的：collect-feeds.mjs 一被 import 就会开始抓取和写库，
 * 没法拿来做单元测试。而这里正是最容易静默出错的地方——解析错了不会报错，
 * 只会安静地产出一堆空标题和坏链接。
 */
import { TOPIC_WORDS, REGION_WORDS } from './feeds.mjs'

/* ------------------------------------------------------------------ *
 * 解析
 *
 * RSS 和 Atom 都够简单，不值得为它引一个依赖进来——这个站点的供应链越小越好。
 * ------------------------------------------------------------------ */

export const strip = (s) => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ')
  .trim()

const tag = (block, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return m ? strip(m[1]) : ''
}

/** Atom 的链接在属性里，RSS 的在标签内容里。 */
function linkOf(block) {
  const rss = tag(block, 'link')
  if (rss && /^https?:\/\//.test(rss)) return rss
  const alt = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block)
    ?? /<link[^>]*href=["']([^"']+)["']/i.exec(block)
  return alt ? strip(alt[1]) : ''
}

const attr = (block, re) => { const m = re.exec(block); return m ? strip(m[1]) : '' }

/**
 * 媒体自己配的图。
 *
 * feed 里本来就带图——`media:content`、`media:thumbnail`、`enclosure`——之前
 * 只取了标题摘要链接，把图整个丢掉了，所以站上全是系统画的抽象封面。
 *
 * 只用媒体自己发出来的图，并且署上它的名字。**不去猜图里有什么**：
 * feed 给了说明就用它当替代文字，没给就只说明出处。给一张没看过的照片编一段
 * 描述，是在骗用读屏软件的人。
 */
export function imageOf(block, outlet) {
  const url = attr(block, /<media:content[^>]*\burl=["']([^"']+)["']/i)
    || attr(block, /<media:thumbnail[^>]*\burl=["']([^"']+)["']/i)
    || attr(block, /<enclosure[^>]*\btype=["']image\/[^"']*["'][^>]*\burl=["']([^"']+)["']/i)
    || attr(block, /<enclosure[^>]*\burl=["']([^"']+\.(?:jpe?g|png|webp))["']/i)
  if (!url || !/^https?:\/\//.test(url)) return null

  const caption = tag(block, 'media:description') || tag(block, 'media:title')
  const credit = tag(block, 'media:credit') || outlet
  return {
    url,
    alt: caption || `${outlet} 为这条报道配发的图片`,
    credit,
  }
}

/**
 * 从报道页面自己的 HTML 里取社交预览图。
 *
 * 为什么要多这一步：feed 里的 `media:thumbnail` 常常是 150px 见方的列表缩略图，
 * 放到首页大卡片上就是一团糊。站长的原话是「你没有给我高质量的标图」。
 *
 * 而 `og:image` 是媒体自己为社交平台准备的那一张——按 1200×630 做的，
 * 是同一家媒体、同一篇报道、同一个编辑挑的图，只是尺寸对得上。
 * 所以有 og:image 就优先用它，没有才退回 feed 里那张。
 *
 * 仍然**不描述图片内容**：alt 只说这是谁为哪篇报道配的图。
 * 我没看过这张图，写「一群女性举着标语」就是编造。
 */
export function ogImage(html, outlet) {
  const meta = (prop) => {
    // property 和 content 的先后顺序在各家模板里都不一样，两种都认。
    const a = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i')
    const b = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i')
    return (html.match(a)?.[1] ?? html.match(b)?.[1] ?? '').trim()
  }
  const url = meta('og:image:secure_url') || meta('og:image') || meta('twitter:image') || meta('twitter:image:src')
  if (!url || !/^https?:\/\//.test(url)) return null

  // 1×1 计数像素、占位图、社交按钮图标——这些都不是配图。
  if (/\b(1x1|pixel|spacer|blank|placeholder|logo|favicon|avatar|sprite)\b/i.test(url)) return null

  const alt = meta('og:image:alt')
  return {
    url,
    alt: alt || `${outlet} 为这条报道配发的图片`,
    credit: outlet,
  }
}

/**
 * 从报道页面里抠出正文。
 *
 * 这是长稿质量的**根本问题**。RSS 的 description 通常只有两三百字，
 * 而站长要的是 1500–3000 字的报道——模型手上没有材料，只能把同一件事
 * 换几种说法写满篇幅。稿子读起来空、重复、爱讲大道理，根源在这里，
 * 不在提示词。
 *
 * 所以把原文正文取回来交给它。取页面这一步本来就要做（配图用 og:image），
 * 顺手把正文也抠出来，不多一次请求。
 *
 * 不引 readability 之类的库：要的只是「把段落文字拿出来」，
 * 几十行正则够用，而且看得懂。抠得不完美没关系——多给模型两千字真实报道，
 * 比给它一个完美的空摘要有用得多。
 */
export function articleText(html, limit = 6000) {
  let h = String(html)

  // 先把不可能是正文的整块删掉。导航和页脚里全是链接文字，
  // 混进去会让模型把「订阅我们的通讯」当成事实写进稿子。
  h = h.replace(/<(script|style|noscript|svg|form|nav|header|footer|aside|figure)\b[\s\S]*?<\/\1>/gi, ' ')

  /*
   * 有 <article> 就只看它——正文几乎总在里面，且能避开推荐位。
   *
   * **但要取最长的那个，不是第一个。** 非贪婪的正则停在第一个 </article>，
   * 而很多新闻页在正文之前先排几张「相关报道」卡片，每张卡片自己就是一个
   * <article>。取第一个，抠出来的是一句话的卡片摘要，然后因为不足 400 字
   * 被判成「没取到正文」——真实抓取里 23 条里有 10 条没拿到正文，这是其中一类。
   */
  const blocks = [...h.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1])
  const longest = blocks.sort((a, b) => b.length - a.length)[0]

  /*
   * 三个容器都试，取抠出来最多的那个。
   *
   * 上一版是 `longest ?? main ?? 整页`——**一旦页面里有任何 <article>，
   * 就再也不会去看 <main> 和整页了**。而正文放在 <div> 里、页面另有一个
   * 小小的 <article>（推荐卡、评论区）的站，抠到的就是那张卡片。
   * 我修了「取第一个」，又在同一个地方留下了「只取一个」。
   *
   * 真实一轮的诊断说得很清楚：取不到正文的六次里，五次是「抠出来太少」，
   * 只有一次是 HTTP 错误——不是被挡，是抠错了地方。
   */
  const containers = [
    longest,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(h)?.[1],
    h,
  ].filter(Boolean)

  /*
   * **按精确度先后试，不是按谁抠得多。**
   *
   * 第一版是「三个都抠，取最长的」，结果整页那一个总是赢——它把正文和
   * 前面几张推荐卡一起抠了出来，比只有正文的那个长。于是「相关报道：……」
   * 又回到了稿子里，正是上一个提交刚修掉的东西。
   *
   * 所以顺序是 <article> → <main> → 整页，谁先够 400 字就用谁；
   * 都不够时才退回最长的那个，聊胜于无。
   */
  const tries = containers.map((c) => paragraphsOf(c, limit))
  const enough = tries.find((t) => t.length >= 400)
  if (enough) return enough.slice(0, limit)
  const best = [...tries].sort((a, b) => b.length - a.length)[0] ?? ''

  /*
   * <p> 抠不出东西时，再试 JSON-LD。
   *
   * 多数新闻站会在页面里塞一段 schema.org 的 NewsArticle，把**正文原文**
   * 放在 articleBody 字段里——那是给搜索引擎看的，比 HTML 干净得多，
   * 也不受人家用 <div> 还是 <p> 排版的影响。
   *
   * 只在前一条路走不通时才用：<p> 那条路保住了段落结构，而这里拿到的是
   * 一整块，段落要靠换行猜。
   */
  const ld = jsonLdBody(String(html))
  if (ld && ld.length > best.length) return ld.slice(0, limit)
  return best.slice(0, limit)
}

/** 从一个容器里把像正文的段落挑出来。 */
function paragraphsOf(body, limit) {
  const paras = []
  for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = strip(m[1])
    /*
     * 太短的多半是图说、署名、「分享到」这类碎片——但**长短要分语种看**。
     *
     * 一开始这里写死 40 个字符，结果把
     *   「检方周一宣布，对一名曾在当地医院任职的医生提出多项控罪。」
     * 这样一段完整的中文丢掉了：它只有 36 个字符。
     * 中文一个字就是一个词，40 字是一整句话；英文 40 字符只有六七个词，
     * 那才真的是图说。和关键词匹配那里是同一个教训。
     */
    const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length
    if (t.length < (cjk > t.length / 3 ? 20 : 60)) continue
    // 常见的非正文段落。
    if (/^(subscribe|sign up|follow us|advertisement|read more|related|订阅|关注我们|广告)/i.test(t)) continue
    paras.push(t)
    if (paras.join('\n\n').length > limit) break
  }
  return paras.join('\n\n')
}

/** 从 schema.org 的 NewsArticle / Article 里取 articleBody。 */
function jsonLdBody(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data
    try { data = JSON.parse(m[1].trim()) } catch { continue }
    // @graph、数组、单个对象三种写法都见过。
    const nodes = Array.isArray(data) ? data : (Array.isArray(data['@graph']) ? data['@graph'] : [data])
    for (const n of nodes) {
      const body = typeof n?.articleBody === 'string' ? n.articleBody.trim() : ''
      if (body.length >= 400) return body.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n')
    }
  }
  return ''
}

export function parseFeed(xml, outlet = '来源媒体') {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? []
  return blocks.map((b) => ({
    title: tag(b, 'title'),
    link: linkOf(b),
    summary: tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'),
    date: tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'),
    image: imageOf(b, outlet),
    /*
     * `<source url="…">媒体名</source>`。
     *
     * 一般的订阅源用不上——那一整条源就是一家媒体。但**新闻搜索的 RSS**
     * （Google News、Bing News）一条结果一家媒体，媒体名只在这个标签里。
     * 没有它，搜来的每条新闻都得叫「来源」。
     */
    source: sourceOf(b),
  })).filter((e) => e.title && e.link)
}

/** `<source url="…">名字</source>` → { url, name }，没有就是 undefined。 */
function sourceOf(block) {
  const m = /<source[^>]*\burl=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i.exec(block)
  if (!m) return undefined
  const name = m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim()
  return { url: m[1].trim(), name }
}

/* ------------------------------------------------------------------ *
 * 判断
 * ------------------------------------------------------------------ */

/**
 * 匹配一个词。
 *
 * 中文和英文必须分开处理：中文没有词边界，「跨性别」就是要按子串找；
 * 英文按子串找会闯祸——第一次真实抓取里，`mexico` 撞进了「New Mexico」，
 * 把美国新墨西哥州一所中学的性侵案归到了拉丁美洲。
 */
const CJK = /[\u4e00-\u9fff]/
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function matches(h, word) {
  const w = word.toLowerCase()
  if (CJK.test(w)) return h.includes(w)
  /*
   * 英文允许一个复数的 s。
   *
   * 真实抓取里漏掉过这一条：
   *   Sexual assaults happening almost every day in Ceuta
   * 词表写的是 'sexual assault'，词边界卡在 assault 后面，
   * 复数的 s 让整条新闻落选——一篇讲一个城市几乎天天发生性侵的报道。
   *
   * 只放开这一个字母，不做词干还原：那需要一整套规则，
   * 而这里要解决的就是单复数。中文没有这个问题，所以只动英文这一支。
   */
  return new RegExp(`(^|[^a-z0-9])${esc(w)}s?([^a-z0-9]|$)`).test(h)
}

export const hay = (e) => `${e.title} ${e.summary}`
  .toLowerCase()
  // 「New Mexico」是美国的州，不是墨西哥。词边界挡不住它——空格两边都成立。
  .replace(/new mexico/g, 'united states')

export function topicsOf(entry) {
  const h = hay(entry)
  return Object.entries(TOPIC_WORDS)
    .filter(([, words]) => words.some((w) => matches(h, w)))
    .map(([k]) => k)
}

/**
 * 是**哪个词**把这条收进来的。
 *
 * 只在演练里用。上一轮我改掉了裸的 'coming out'，跑完发现美联社那条
 * 「秋季新片上映指南」还在名单上——我在本地只试了标题，而 topicsOf 连
 * 摘要一起看，真正命中的那个词我根本不知道是哪一个，只能再猜一轮。
 *
 * 「这条为什么被收进来」应该是日志能直接回答的问题，不是猜谜。
 */
export function matchedWords(entry) {
  const h = hay(entry)
  const out = []
  for (const [topic, words] of Object.entries(TOPIC_WORDS)) {
    for (const w of words) if (matches(h, w)) out.push(`${topic}:${w}`)
  }
  return out
}

export function regionsOf(entry, feed) {
  const h = hay(entry)
  const hit = Object.entries(REGION_WORDS)
    .filter(([, words]) => words.some((w) => matches(h, w)))
    .map(([k]) => k)
  // 认出来的优先；认不出来就用这个源本来覆盖的地区。
  return hit.length ? hit.slice(0, 3) : feed.regions
}

/* ------------------------------------------------------------------ *
 * 网址 → 媒体名
 *
 * 联网搜来的来源只有网址，没有名字。第一版直接拿域名当名字，结果是：
 *
 *   www.theguardian.com  →  Theguardian
 *   www.bbc.co.uk        →  Bbc.co
 *   news.un.org          →  News.un
 *   m.thepaper.cn        →  M.thepaper
 *
 * 这些会印在每一条新闻底下给读者看。「Theguardian」不是《卫报》的名字，
 * 「Bbc.co」谁都不是。
 * ------------------------------------------------------------------ */

/** 常见的两段后缀。不认得它们，bbc.co.uk 会被切成「Bbc.co」。 */
const TWO_PART_TLD = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'or.jp', 'co.kr', 'or.kr', 'com.hk', 'org.hk', 'com.tw', 'org.tw',
  'com.cn', 'org.cn', 'net.cn', 'com.sg', 'com.my', 'co.id', 'co.th',
  'com.br', 'com.mx', 'com.ar', 'co.za', 'co.nz', 'com.ng', 'co.in', 'com.pk',
])

/** 搜索常会搜到、但我们没有订阅的几家。写出来比让读者猜好。 */
const KNOWN = {
  'reuters.com': '路透社', 'apnews.com': '美联社', 'bbc.co.uk': 'BBC', 'bbc.com': 'BBC',
  'theguardian.com': '卫报', 'nytimes.com': '纽约时报', 'washingtonpost.com': '华盛顿邮报',
  'aljazeera.com': '半岛电视台', 'france24.com': 'France 24', 'npr.org': 'NPR',
  'cnn.com': 'CNN', 'abc.net.au': 'ABC（澳）', 'cbc.ca': 'CBC（加）', 'dw.com': '德国之声',
  'rfi.fr': '法广', 'scmp.com': '南华早报', 'japantimes.co.jp': '日本时报',
  'koreaherald.com': '韩国先驱报', 'straitstimes.com': '海峡时报',
  'un.org': '联合国', 'who.int': '世界卫生组织', 'unwomen.org': '联合国妇女署',
  'unicef.org': '联合国儿童基金会', 'ohchr.org': '联合国人权高专办',
  'hrw.org': '人权观察', 'amnesty.org': '国际特赦组织',
  'thepaper.cn': '澎湃新闻', 'caixin.com': '财新', 'thewitnesshk.com': '法庭線',
  'inmediahk.net': '獨立媒體', 'twreporter.org': '报导者', 'theinitium.com': '端传媒',
}

/** 去掉 www / m / amp / news 这类前缀之后，可以注册的那一段域名。 */
export function registrableHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '')
    const parts = host.split('.')
    if (parts.length <= 2) return host
    const lastTwo = parts.slice(-2).join('.')
    return TWO_PART_TLD.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo
  } catch { return '' }
}

/**
 * 这个网址是哪一家。
 *
 * 顺序：先问我们自己的源清单（那里的名字是中文的，和站上其余来源一致），
 * 再查上面那张常见媒体表，都没有才回退到域名——而且回退也要清理干净：
 * 去掉后缀、把中划线换成空格、首字母大写。theguardian.com 至少变成
 * 「Theguardian」而不是「Www.theguardian.com」，reuters.com 直接是「路透社」。
 */
export function outletFor(url, feeds = []) {
  const host = registrableHost(url)
  if (!host) return '来源'

  /*
   * **先查这张表，再查源清单。**
   *
   * 反过来会出这种错：我们订的是联合国新闻的「妇女」专题，域名是 un.org；
   * 于是任何一条 un.org 的链接——包括人权、气候、安理会——都会被标成
   * 「联合国新闻 · 妇女」。域名只到可注册那一层，分不出站内的栏目。
   * 大站按这张表给一个中性的名字（「联合国」），小站再交给源清单，
   * 那里一个域名就是一家媒体，不会认错。
   */
  if (KNOWN[host]) return KNOWN[host]

  for (const f of feeds) {
    const urls = Array.isArray(f.url) ? f.url : [f.url]
    if (urls.some((u) => registrableHost(u) === host)) return f.outlet ?? f.publisher ?? host
  }

  const core = host.slice(0, host.lastIndexOf('.')) || host
  return core.split(/[-.]/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 60)

/** 摘要留给站长改，但先给一段能读的——原样来自媒体，不加工。 */
export function summaryOf(entry) {
  const s = entry.summary || ''
  if (s.length <= 400) return s
  const cut = s.slice(0, 400)
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('！'))
  return (stop > 200 ? cut.slice(0, stop + 1) : cut) + '…'
}


/* ------------------------------------------------------------------ *
 * 去重
 *
 * 站长的要求是「不要有任何重复」。按链接去重远远不够——同一件事被路透、
 * 卫报、19th 各报一次，就会变成三条几乎一样的新闻堆在首页上。
 *
 * 但这个网站的数据模型本来就允许一条新闻挂**多个媒体链接**，而且页面上会
 * 把来源列出来。所以正确的做法不是丢掉后来的两条，而是**把它们合并成一条、
 * 三个来源**——读者反而看到了更多可核对的出处。
 * ------------------------------------------------------------------ */

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'as', 'by', 'from', 'that', 'this', 'it', 'its',
  'after', 'over', 'into', 'says', 'said', 'new', 'more', 'how', 'why', 'what'])

/**
 * 简繁归一。
 *
 * 台港台媒体写「台灣」「跨性別」「權利」，内地和多数中文源写「台湾」「跨性别」
 * 「权利」。不归一的话，同一件事的两个标题**一个字都对不上**——这个站同时收
 * 中港台三地的来源，不处理等于中文去重根本不工作。
 *
 * 只收本站题材里高频的那些字，不做完整转换表。
 */
const T2S = { '灣': '湾', '臺': '台', '別': '别', '權': '权', '國': '国', '網': '网', '變': '变',
  '認': '认', '議': '议', '訴': '诉', '訟': '讼', '審': '审', '報': '报', '華': '华', '後': '后',
  '歲': '岁', '眾': '众', '關': '关', '擊': '击', '譴': '谴', '責': '责', '長': '长', '學': '学',
  '醫': '医', '療': '疗', '傳': '传', '統': '统', '應': '应', '記': '记', '證': '证', '檢': '检',
  '無': '无', '韓': '韩', '員': '员', '們': '们', '個': '个', '對': '对', '產': '产', '婦': '妇',
  '導': '导', '這': '这', '會': '会', '為': '为', '與': '与', '從': '从', '將': '将', '爭': '争' }

const simp = (t) => t.replace(/[\u4e00-\u9fff]/g, (c) => T2S[c] ?? c)

/** 很轻的英文词形归一：shows→show、banning→ban、struck 和 strikes 都收敛到 strik。 */
function stem(w) {
  return w
    .replace(/(ings?|ed|es|s)$/, '')
    .replace(/(.)\1$/, '$1')
}

/**
 * 把标题拆成比较用的词集。
 *
 * 英文按词并做轻度归一；中文没有空格，按**相邻两字**切——「性侵案」给出
 * 「性侵」「侵案」，这样换个说法但讲同一件事的两个标题仍然重叠得上。
 */
export function tokens(title) {
  const t = simp(String(title ?? '').toLowerCase())
  const out = new Set()
  for (const w of t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
    if (w.length >= 3 && !STOP.has(w) && !CJK.test(w)) out.add(stem(w))
  }
  const cjk = t.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i += 1) out.add(cjk.slice(i, i + 2))
  return out
}

/**
 * 两个标题讲的是同一件事吗。
 *
 * 用重叠系数而不是 Jaccard：一个长标题和一个短标题讲同一件事时，
 * Jaccard 会被长的那个稀释掉，重叠系数不会。
 */
export function sameStory(a, b, threshold = 0.42) {
  const A = a instanceof Set ? a : tokens(a)
  const B = b instanceof Set ? b : tokens(b)
  if (A.size === 0 || B.size === 0) return false
  let hit = 0
  for (const w of A) if (B.has(w)) hit += 1
  return hit / Math.min(A.size, B.size) >= threshold
}

/** 同一篇文章的网址会带各种跟踪参数，比较之前先洗掉。 */
export function normUrl(u) {
  try {
    const x = new URL(u)
    x.hash = ''
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source|CMP|cmp)/i.test(k)) x.searchParams.delete(k)
    }
    return `${x.origin}${x.pathname.replace(/\/$/, '')}${x.search}`
  } catch {
    return String(u ?? '')
  }
}

/* ------------------------------------------------------------------ *
 * 内容提示
 *
 * 站长要求把「等他审核」这一层去掉，全部自动上线——包括针对公众人物的性犯罪
 * 指控，那正是他指定的报道重心。这是他的网站，这个决定是他的。
 *
 * 剩下的这一件不挡发布，只是给读者一句话：这个站本来就给这类条目写内容提示
 * （演示数据里的原话是「本条涉及性骚扰案件的审理程序。总结不描述任何具体案情。」），
 * 而一个持续报道性暴力的站点，让读者在点开之前知道自己要读什么，是它本来的做法。
 */
const ACCUSATION = [
  'accused of', 'accuses', 'allegation', 'alleged', 'alleges', 'denies',
  'charged with', 'indicted', 'on trial', 'convicted', 'sentenced', 'acquitted',
  'lawsuit against', 'sues', 'guilty of', 'arrested',
  '被控', '被指控', '指控', '否认', '否認', '起诉', '起訴', '被捕', '判刑', '定罪', '无罪', '無罪',
]

/** 这条讲的是一桩具体案件吗。排序时用得上：司法进展优先。 */
export function isCase(entry) {
  const h = hay(entry)
  return ACCUSATION.some((w) => matches(h, w))
}

/*
 * 这里原本还有 noticeFor()：给性暴力类条目自动挂一句内容提示
 * （「本条涉及具体案件，摘要直接来自原报道……」）。
 *
 * 站长要求去掉，理由成立：这个站**每一条**都是性别暴力相关的报道，
 * 一个几乎条条都挂的提示等于没有提示——它只是在每张卡片顶上压了一条红带，
 * 把注意力从新闻本身挪开，还让站点看起来像在替自己免责。
 * 读者知道自己点开的是什么，标题就写着。
 */
