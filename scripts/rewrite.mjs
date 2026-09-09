/**
 * 把抓回来的候选，交给模型按编辑方针筛选并改写成中文条目。
 *
 * 抓取只负责「拿到候选」，判断和写作在这里。分开是有理由的：
 * 方针会变（站长随时可能改十一条里的权重），抓取不该跟着改。
 *
 * 模型做四件事，一次做完：
 *   1 按方针决定这条要不要——不符合的直接丢，宁缺毋滥
 *   2 重写中文标题（不是直译，按语气准则：主语放回施害者、点名权力）
 *   3 写详细中文总结，按「每一条要回答的问题」组织
 *   4 归类地区与议题
 *
 * 一批一批发。批太大模型会开始偷懒——后面几条越写越短；批太小则调用次数翻倍，
 * 免费额度撑不住。六条是个折中。
 */
import { ask, askText, llmName } from './llm.mjs'
import { splitBlocks, parseBlock, parseList, parseEnum, parseYes } from './blocks.mjs'
import { TOPICS, REGIONS, REGION_ALIAS } from './taxonomy.mjs'
import { cleanLine, stripSelfVoice } from './voice.mjs'
import { systemPrompt, triagePrompt } from './editorial.mjs'

/*
 * 一批几条。
 *
 * 站长要每条总结 1000 字左右，六条一批就是六千多字的输出——很容易撞上
 * max_tokens，而撞上的表现是**整批返回空**（模型写到一半被截断，一个字都没落地）。
 * 三条一批留出余量。批次多一倍意味着系统提示词多发一倍，但那是几千 token 的
 * 输入，比丢掉一整批便宜得多。
 */
const BATCH = Number(process.env.LLM_BATCH ?? 2)

/*
 * 联网找来源，默认开着。
 *
 * 站长明确要求「加上 3-5 个 sources，看完 sources，进行总结」。
 * 它只在 Claude 那条路上有（是 Anthropic 的服务端工具），而且要花钱：
 * 每次搜索一美分。要关掉就设 LLM_SEARCH=0。
 */
const SEARCH = process.env.LLM_SEARCH !== '0'
const anthropicBacked = () => Boolean((process.env.ANTHROPIC_API_KEY ?? '').trim())

/*
 * **一轮里有几条走联网搜索。**
 *
 * 实测：搜过的一条 0.69 美元，没搜的大约 0.19。站长设的是一天两场、
 * 每场 15 条——三十条全搜，一个月约 625 美元，而他账上是 20 美元，
 * 也就是**不到一天就会用完，然后每一场都失败**。
 *
 * 所以默认只给排在最前面的几条：它们是当天的头条，是读者真正会点进去
 * 读完的那几条，也是「三到五个来源」最值钱的地方。排在后面的仍然会写，
 * 用我们自己抓回来的原文，一千五百字上下。
 *
 * 这是**成本上的取舍，不是我替站长做的判断**——LLM_SEARCH_TOP 调成
 * 15 就是全都搜，调成 0 就是都不搜。日志里会写清楚这一轮搜了几条。
 */
const SEARCH_TOP = Number(process.env.LLM_SEARCH_TOP ?? 5)

const SHAPE = `
每一条候选写成一个块，**不要用 JSON**，照下面的格式：

===ITEM 0===
KEEP: yes
HEADLINE: 主标题
SUBHEAD: 副标题，一句话
TOPICS: sexual, children
REGIONS: us
BULLETS:
- 要点一
- 要点二
SUMMARY:
正文第一段。

正文第二段。可以直接换行、直接空行，不需要转义。

## 小标题

正文继续。句子后面用 [1] [2] 标出处。
===END 0===

规则：
- 每一条候选都要有一个块，编号就是输入里的 i，顺序不变，不要增删。
- 不符合方针的写 KEEP: no，其余字段可以留空。
- SUMMARY 从冒号后**换行开始**，一直写到 ===END 为止。
- TOPICS 只能从这些里选：domestic sexual children rights lgbtq hate displacement incel movement
- REGIONS 只能从这些里选：cn hk jpkr us eu anz sea sasia mena ru africa latam global
  （jpkr = 日本、韩国、台湾；us = 美国与加拿大；eu 含格陵兰）`.trim()

/** 把一批候选交给模型。返回和输入等长的结果数组。 */
/** 这一轮还能搜几条。runBatch 每写一条搜过的就减一。 */
const searchBudget = { left: 0 }

async function runBatch(batch, ownerNote) {
  const input = batch.map((p, i) => ({
    i,
    title: p.title,
    /*
     * 原文正文，可能不止一篇——同一件事被两三家报道时，每一家都取回来了。
     * 这是模型写长稿的**材料**：没有它，1500 字只能靠车轱辘话凑；
     * 有了好几家，细节还能互相补上（这家有法庭文件，那家采访到了当事人）。
     * 一篇都没取到才退回 feed 摘要。
     */
    articles: p.bodies?.length ? p.bodies : undefined,
    excerpt: p.bodies?.length ? undefined : p.summary,
    date: p.at.slice(0, 10),
    /*
     * 来源按 [1] [2] 编号交给模型，让它在正文里标角标。
     * 一条新闻常常已经合并了好几家的报道（同一件事多个来源），
     * 站长要求「引用尽量使用多过一个引用」——这里把它们都列出来，
     * 模型才有第二个可标的东西。
     */
    sources: [{ n: 1, outlet: p.feed.outlet, lang: p.feed.lang, url: p.link },
      ...(p.also ?? []).map((o, k) => ({ n: k + 2, outlet: o.feed.outlet, lang: o.feed.lang, url: o.link }))],
  }))
  /*
   * **开着联网搜索的时候，一次只写一条。**
   *
   * 站长：「你怎么只搜索一个 source？我希望你找到新闻后，抽取新闻标题进行
   * 二次搜索，然后加上 3-5 个 sources，看完 sources，进行总结。」
   *
   * 一批两条时，模型的搜索结果是混在同一个回合里的：两条新闻的搜索、抓取、
   * 正文交错着出现，谁的来源是谁的就分不清了——挂错来源比没有来源更糟。
   * 一条一条写，found 就明确属于这一条。
   */
  const ask1 = (items, searching) => askText(
    `${systemPrompt(ownerNote)}\n\n${SHAPE}`,
    `候选新闻 ${items.length} 条。\n`
    + `**articles 是原报道的正文**，可能有好几篇——都是同一件事的不同来源。\n`
    + `全部读完，写成**一篇**稿子：细节该谁补谁补，不要写成「A 媒体说……B 媒体说……」。\n`
    + (searching
      ? `\n**先补来源，再动笔。** 用 web_search 拿这条新闻的关键信息（人名、地点、\n`
        + `机构、案件）去搜同一件事的其他报道——不要照抄标题去搜，标题里的\n`
        + `修辞词会把搜索带偏。找到之后用 web_fetch 把值得读的那几篇抓回来读完，\n`
        + `**总共凑够三到五个来源**（手上已有的算在内），再开始写。\n`
        + `优先找：通讯社与大报的同题报道、法院或政府的原始文件、当地媒体的细节。\n`
        + `搜不到就照手上的材料写，不要为了凑数把不相干的报道算成来源。\n`
        + `正文里出处要分别点名（据《卫报》报道 / 路透社查阅的法庭文件显示）。\n`
      : `只有 excerpt 的那几条材料很少，就写短一点，不要靠重复凑字数。\n`
        + `**两家以上报道的，出处要在正文里分别点名**（据 X 报道 / Y 查阅的文件显示），\n`
        + `读者才看得出这件事不止一家在讲。\n`)
    + `\n${JSON.stringify(items, null, 1)}`,
    { maxTokens: 24000, search: searching },
  )

  /*
   * 预算是**按条**花的，不是按批。
   *
   * 第一版把「这一批要不要搜」在批的开头算一次——预算只剩 1 条时，
   * 一批两条会两条都搜，悄悄超支。预算是拿站长的钱定的，不能这样漏。
   */
  if (searchBudget.left <= 0) {
    const { text } = await ask1(input, false)
    return matchBack(batch, text)
  }

  // 一条一条来，各自带回自己搜到的来源。
  const out = []
  for (let i = 0; i < input.length; i += 1) {
    const searching = searchBudget.left > 0
    try {
      if (searching) searchBudget.left -= 1
      const { text, found } = await ask1([{ ...input[i], i: 0 }], searching)
      const [item] = matchBack([batch[i]], text)
      if (item && searching) item.__found = found
      out.push(item)
    } catch (e) {
      console.log(`  第 ${i + 1} 条写失败：${String(e.message ?? e).slice(0, 120)}`)
      out.push(null)
    }
  }
  return out
}

/** 按编号把块对回候选，而不是按出现顺序——模型偶尔会漏掉一整块。 */
function matchBack(batch, text) {
  const blocks = splitBlocks(text)
  if (blocks.length === 0) {
    throw new Error(`没找到 ===ITEM=== 块：${text.slice(0, 200)}`)
  }
  return batch.map((_, i) => {
    const b = blocks.find((x) => x.i === i)
    return b ? parseBlock(b.body, FIELDS) : null
  })
}

const FIELDS = ['KEEP', 'HEADLINE', 'SUBHEAD', 'TOPICS', 'REGIONS', 'BULLETS', 'SUMMARY']

/* 议题与地区的名单在 scripts/taxonomy.mjs——手写稿那条路也用同一份。 */

/**
 * 校验模型的产出。
 *
 * 模型偶尔会编一个不存在的议题名，或者把总结写成一句话。这些不该悄悄进站——
 * 前者会让筛选页出现一个点不开的标签，后者就是站长说的「总结不够详细」。
 */
export function clean(raw, fallback) {
  if (!raw || !parseYes(raw.KEEP)) return null
  const headline = String(raw.HEADLINE ?? '').trim()
  /*
   * 先把「本站自述」的句子删掉，再量长度。
   *
   * 提示词里已经写了不许这么写（见 editorial.mjs 的红线），这里是兜底：
   * 模型是概率的，而「PRISM 将持续关注该案后续」这种句子一旦漏出去，
   * 就是一句白纸黑字的假话——这个站不派记者、不打电话、不去旁听。
   *
   * 顺序要紧：删完再量。删掉之后不足 400 字的，说明那篇本来就没写多少
   * 实质内容，正好一起丢掉。
   */
  const summary = stripSelfVoice(String(raw.SUMMARY ?? '').trim())
  if (!headline || summary.length < 400) return null // 太短就是没写，宁可不要

  const topics = parseEnum(raw.TOPICS, TOPICS)
  const regions = parseEnum(raw.REGIONS, REGIONS, REGION_ALIAS)
  return {
    headline,
    subhead: cleanLine(String(raw.SUBHEAD ?? '').trim()) || null,
    summary,
    bullets: parseList(raw.BULLETS).map(cleanLine).filter(Boolean).slice(0, 6),
    topics: topics.length ? topics : fallback.topics,
    regions: regions.length ? regions : fallback.regions,
    // 联网搜到、并且真的被读过的那几篇。collect 会把它们挂成额外来源。
    found: Array.isArray(raw.__found) ? raw.__found : [],
  }
}

/* ------------------------------------------------------------------ *
 * 第一步：先挑，再写
 *
 * 长稿把一个隐藏的浪费放大了出来。模型按方针要丢掉七八成候选，而在原来的
 * 单段流程里，**每一条被丢掉的候选都是先写满两三千字才被丢的**——
 * 一轮收集大半的钱和时间，花在了永远不会上线的稿子上。
 *
 * 所以拆成两步。挑的那一步一次看二十条，每条只回一个 true/false 和一句理由，
 * 输出几十个 token；写的那一步只碰留下来的。
 * 长输出的调用次数从「候选数 ÷ 2」降到「目标数 ÷ 2」。
 * ------------------------------------------------------------------ */

const TRIAGE_BATCH = Number(process.env.LLM_TRIAGE_BATCH ?? 20)

const TRIAGE_SHAPE = `
只返回 JSON，形如：
{"picks":[{"i":0,"keep":true,"why":"检方起诉，涉及机构失察"},{"i":1,"keep":false,"why":"名人八卦"}]}

picks 必须覆盖输入里的每一个 i，不要增删。why 写十个字以内，只是给日志看的。`.trim()

/** 先挑一遍。返回留下来的候选，顺序不变。 */
async function triage(cands, ownerNote, target) {
  const kept = []
  let looked = 0
  for (let i = 0; i < cands.length; i += TRIAGE_BATCH) {
    const batch = cands.slice(i, i + TRIAGE_BATCH)
    looked += batch.length
    try {
      const out = await ask(
        `${triagePrompt(ownerNote)}\n\n${TRIAGE_SHAPE}`,
        `今天要上线 ${target} 条，这是第 ${Math.floor(i / TRIAGE_BATCH) + 1} 批候选（共 ${cands.length} 条）。\n`
        + `符合方针的都留下——**宁可多留几条**：后面写的时候还会再筛一次，\n`
        + `而留得太少的话，今天就凑不够 ${target} 条。\n\n`
        + `候选 ${batch.length} 条：\n\n${JSON.stringify(
          batch.map((c, k) => ({ i: k, source: c.feed.outlet, title: c.title, excerpt: String(c.summary).slice(0, 300) })),
          null, 1,
        )}`,
        /*
         * 初筛用便宜的型号，力气也给小的。
         *
         * 这一步的输出是一个布尔值加十个字的理由——**让 Opus 来做，
         * 是在为一件它的判断力派不上用场的事付钱，还慢**。写稿那一路
         * 才需要最好的模型。站长在 Secrets 里指定过 LLM_MODEL 的话，
         * 那是他的选择，两边都听他的。
         */
        { maxTokens: 2000, model: process.env.LLM_MODEL || 'claude-sonnet-5', effort: 'low' },
      )
      const picks = Array.isArray(out?.picks) ? out.picks : []
      for (const p of picks) {
        if (p?.keep && batch[p.i]) kept.push(batch[p.i])
      }
    } catch (e) {
      // 挑这一步失败就把这一批**全部留下**，交给写的那一步去筛。
      // 宁可多花钱，也不要因为一次网络抖动就把二十条真新闻整批扔掉。
      console.log(`  初筛第 ${Math.floor(i / TRIAGE_BATCH) + 1} 批失败，这批全部留给下一步：${String(e.message ?? e).slice(0, 80)}`)
      kept.push(...batch)
    }
  }
  console.log(`  初筛：看 ${looked} 条，留 ${kept.length} 条`)
  return kept
}

/**
 * 一直跑到够数为止。
 *
 * 第一次真实收集只上线了 3 条：模型按方针从 24 条里丢掉了 21 条。方针本来就写着
 * 「宁缺毋滥」，丢得多不是 bug——**但把候选数当成目标数就是**。喂 30 条进去，
 * 站长拿到的不是 30 条，是 3 条。
 *
 * 所以这里改成按**产出**算：一批一批地喂，够了就停，不够就继续往下拿候选。
 * 停得早就省钱，丢得多就多跑几批，两头都不用人去猜一个「大概喂多少」的数。
 *
 * `picked` 要比目标长得多（收集脚本按四倍准备）。真的喂完了还不够，
 * 那是今天的新闻确实不够，不是这里的问题——如实报出来。
 *
 * 一批失败不拖垮整次收集——报出来，继续下一批。
 */
export async function rewriteAll(candidates, ownerNote = '', target = Infinity, { onPicked } = {}) {
  console.log(`交给模型（${llmName()}），目标 ${target === Infinity ? '全部' : `${target} 条`}`)

  /*
   * 先挑后写。挑的那一步便宜，写的那一步贵——所以别在会被丢掉的稿子上动笔。
   * 只有一批的时候不值得多跑一次调用，直接写。
   */
  const picked = candidates.length > BATCH * 2
    ? await triage(candidates, ownerNote, target === Infinity ? candidates.length : target)
    : candidates
  if (picked.length === 0) {
    console.log('  初筛之后一条都不剩。今天的候选里没有符合方针的。')
    return []
  }

  /*
   * 选完了再去取原文。
   *
   * 顺序是关键：取报道页面要发几十个 HTTP 请求，只对**留下来的**做才划算；
   * 而它必须在写之前做完，否则模型手上只有 RSS 那两三百字的摘要，
   * 写 1500–3000 字就只能靠注水。
   */
  if (onPicked) await onPicked(picked)

  /*
   * 取到原文的排前面。
   *
   * 实测：读过报道正文写出来的稿子平均 1672 字，只有 RSS 摘要的平均 855 字。
   * 而写到目标条数就停——所以**先写谁，直接决定了当天上线的是哪一批**。
   * 候选备的是目标的四倍，其中十几条会写不到，那就让写得成的先上。
   *
   * 只在**同一个议题层内**调换。性犯罪仍然排在最前面（站长定的重心），
   * 不能因为某篇取不到正文，就把一篇家暴报道顶到性侵案前面去。
   * sort 是稳定的，所以层内原来的顺序（多来源、主流媒体、时间）也保住了。
   */
  const tier = (p) => (p.topics.includes('sexual') ? 0 : p.topics.includes('domestic') ? 1 : p.topics.includes('children') ? 2 : 3)
  picked.sort((a, b) => tier(a) - tier(b) || (a.bodies?.length ? 0 : 1) - (b.bodies?.length ? 0 : 1))

  searchBudget.left = SEARCH && anthropicBacked() ? Math.min(SEARCH_TOP, picked.length) : 0
  if (searchBudget.left > 0) {
    console.log(`  开始写：前 ${searchBudget.left} 条联网找来源，其余用手上的材料`)
  } else {
    console.log(`  开始写（每批 ${BATCH} 条）`)
  }
  const out = []
  let dropped = 0
  let failed = 0
  let seen = 0

  for (let i = 0; i < picked.length; i += BATCH) {
    if (out.length >= target) break
    const batch = picked.slice(i, i + BATCH)
    seen += batch.length
    try {
      const items = await runBatch(batch, ownerNote)
      items.forEach((raw, j) => {
        const c = clean(raw, batch[j])
        if (!c) { dropped += 1; return }
        out.push({ ...batch[j], ...c })
      })
    } catch (e) {
      failed += batch.length
      console.log(`  第 ${Math.floor(i / BATCH) + 1} 批失败：${String(e.message ?? e).slice(0, 120)}`)
    }
  }

  // 多留下的那几条不丢——同一批里的，钱已经付过了。
  const kept = target === Infinity ? out : out.slice(0, target)
  console.log(`  收 ${kept.length} 条 · 看过 ${seen} 条候选 · 按方针丢弃 ${dropped} 条${failed ? ` · ${failed} 条因调用失败没处理` : ''}`)
  if (kept.length < target && seen >= picked.length) {
    console.log(`  没凑够 ${target} 条：候选全看完了。今天符合方针的就这么多。`)
  }

  /*
   * 全军覆没要喊出来。
   *
   * 免费额度用完、key 填错、模型名不存在——这几种都会让每一批都失败，
   * 而如果只是静静地写 0 条，站长看到的是「今天没有新闻」，
   * 完全想不到是额度的问题。这类沉默的失败，这个项目已经踩过太多次。
   */
  if (kept.length === 0 && failed > 0) {
    console.log('')
    console.log('!! 每一批都失败了。常见原因，按可能性排：')
    console.log('   1 免费额度用完或需要绑定付款方式（错误信息里通常有 quota / credit / billing）')
    console.log('   2 LLM_MODEL 名字不对——供应商的型号名会变，去它的控制台核对一次')
    console.log('   3 LLM_API_KEY 不对，或者 LLM_BASE_URL 少了 /v1')
    console.log('   照着 probe 跑一次（Run workflow 勾 probe），它会直接告诉你是哪一种。')
    console.log('   上面每一批的错误原文就是答案，照着看。')
  }
  return kept
}

/* ------------------------------------------------------------------ *
 * 研究与数据
 *
 * 站长要每天 30 条新闻**加 3 项研究**。研究不是短新闻，不能套同一套提示词：
 * 新闻回答「发生了什么」，研究要回答「这个数字撑得起什么结论、撑不起什么」。
 *
 * 所以多要两样东西：
 *   - limitation：这份研究**做不到**什么。研究页会把它印在数字旁边。
 *     一个不写局限的数据站，是在帮读者过度解读。
 *   - figures：最多三个关键数字，每个都必须带一句「它没说什么」。
 *
 * 一天只要 3 项，所以一批发完，不分批。
 * ------------------------------------------------------------------ */

const STUDY_SHAPE = `
每一项写成一个块，**不要用 JSON**：

===ITEM 0===
KEEP: yes
TITLE: 中文标题
PUBLISHER: 中文机构名
KIND: official-statistics
TOPICS: sexual, children
REGIONS: global
FIGURES:
- 指标名 | 数字带单位 | 这个数字没有说什么
- 指标名 | 数字带单位 | 这个数字没有说什么
LIMITATION:
这份研究撑不起什么结论，一到两句。
SUMMARY:
按新闻的写法写，1000–1500 字，分段。可以直接换行。
===END 0===

规则：
- 每一项都要有一个块，编号是输入里的 i，顺序不变。不属于本站题目的写 KEEP: no。
- KIND 只能是：peer-reviewed systematic-review official-statistics dataset ngo-report preprint
- TOPICS 只能从这些里选：domestic sexual children rights lgbtq hate displacement incel movement
- REGIONS 只能从这些里选：cn hk jpkr us eu anz sea sasia mena ru africa latam global
  （jpkr = 日本、韩国、台湾；us = 美国与加拿大；eu 含格陵兰）
- FIGURES 里只放**原文里真的出现过的数字**，一行一个，三段用 | 隔开。
  原文没给数字就整个留空——编一个数字比没有数字糟糕得多。
  第三段（它没说什么）不能空着：每个数字都要说清它的边界。
- LIMITATION 同理，宁可写「原报告未说明抽样方法」，也不要编一个方法出来。
- 输入里有 article 字段时，那是**报告页的正文**，以它为准来写：
  方法、样本量、时间范围、局限通常都写在那里。摘要（excerpt）只是通告。
  只有 excerpt、没有 article 的，就照它能支撑的长度写，八百字打住——
  硬凑到一千五只会把同一句话换三种说法。`.trim()

const STUDY_FIELDS = ['KEEP', 'TITLE', 'PUBLISHER', 'KIND', 'TOPICS', 'REGIONS', 'FIGURES', 'LIMITATION', 'SUMMARY']

const KINDS = new Set(['peer-reviewed', 'systematic-review', 'official-statistics', 'dataset', 'ngo-report', 'preprint'])

/** 校验一项研究。和新闻一样：模型编出来的字段不该悄悄进站。 */
export function cleanStudy(raw, fallback) {
  const topics = parseEnum(raw?.TOPICS, TOPICS)
  const regions = parseEnum(raw?.REGIONS, REGIONS, REGION_ALIAS)
  const kind = String(raw?.KIND ?? '').trim()

  /*
   * 数字一行一个：指标 | 数值 | 它没说什么。
   * 三段缺任何一段就丢掉——研究页把数字印得很大，一个没有边界说明的数字
   * 比不放这个数字糟糕得多。
   */
  const figures = parseList(raw?.FIGURES)
    .map((line) => line.split('|').map((x) => x.trim()))
    .filter((p) => p.length >= 3 && p[1] && p[2])
    .slice(0, 3)
    .map((p) => ({ label: p[0], value: p[1], note: p.slice(2).join(' | ') }))

  // 研究这一路同样不许出现叙述者——理由见 voice.mjs。
  const summary = stripSelfVoice(String(raw?.SUMMARY ?? '').trim())
  return {
    ...fallback,
    title: String(raw?.TITLE ?? '').trim() || fallback.title,
    publisher: String(raw?.PUBLISHER ?? '').trim() || fallback.publisher,
    // 模型给了个不存在的类型，就退回这个源的默认类型，不要让研究页
    // 出现一个显示不出可信度提示的空类别。
    kind: KINDS.has(kind) ? kind : fallback.kind,
    summary: summary.length >= 400 ? summary : fallback.summary,
    limitation: stripSelfVoice(String(raw?.LIMITATION ?? '').trim()) || '原报告未说明方法与抽样，这里不代为推断。',
    figures,
    topics: topics.length ? topics : fallback.topics,
    regions: regions.length ? regions : fallback.regions,
  }
}

/** 把候选研究交给模型。返回保留下来的那些。 */
export async function rewriteStudies(cands, ownerNote) {
  if (cands.length === 0) return []
  const input = cands.map((c, i) => ({
    i,
    publisher: c.feed.publisher,
    defaultKind: c.feed.kind,
    title: c.title,
    excerpt: c.summary,
    // 报告页的正文。取到了就以它为准——摘要只有两三百字，
    // 方法、样本量和局限基本都在正文里，而那正是这一栏要写的东西。
    ...(c.body ? { article: c.body.slice(0, 6000) } : {}),
    url: c.link,
    date: c.at.slice(0, 10),
  }))
  console.log(`交给模型处理 ${cands.length} 项候选研究（${llmName()}）`)
  try {
    const text = await askText(
      `${systemPrompt(ownerNote)}\n\n${STUDY_SHAPE}`,
      `候选研究 ${input.length} 项：\n\n${JSON.stringify(input, null, 1)}`,
      { maxTokens: 24000 },
    )
    const blocks = splitBlocks(text)
    if (blocks.length === 0) throw new Error(`没找到 ===ITEM=== 块：${text.slice(0, 200)}`)
    const kept = []
    cands.forEach((c, i) => {
      const b = blocks.find((x) => x.i === i)
      if (!b) return
      const f = parseBlock(b.body, STUDY_FIELDS)
      if (!parseYes(f.KEEP)) return
      kept.push(cleanStudy(f, c))
    })
    console.log(`模型留下 ${kept.length} 项，丢掉 ${cands.length - kept.length} 项`)
    return kept
  } catch (e) {
    // 研究是「加分项」，不该因为它失败就把整轮新闻也拖掉。
    console.log(`研究这一步失败了：${String(e.message ?? e).slice(0, 200)}`)
    console.log('这一轮就不加研究了，新闻不受影响。')
    return []
  }
}
