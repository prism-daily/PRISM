/**
 * 议题与地区的**唯一一份名单**。
 *
 * 原来这份名单写在 rewrite.mjs 里，因为只有模型的产出需要校验。现在
 * 手写的稿子（scripts/publish.mjs）也要用同一套标签，而两处各抄一份的
 * 结果是可以预见的：以后再合并一个地区标签，改了一处忘了另一处，
 * 于是同一个词在一条路上有效、在另一条路上被静默丢掉——
 * 一篇稿子发出去之后「没有地区」，谁也不会当场发现。
 *
 * 所以放这里，两边都从这里取。要加或改标签，只动这个文件，
 * 并且记得 src/lib/ 那边（网站显示用的中文名）也有对应的一份。
 */

export const TOPICS = new Set([
  'domestic', 'sexual', 'children', 'rights', 'lgbtq', 'hate', 'displacement', 'incel', 'movement',
])

/*
 * 'tw' 不在里面了——台湾并进了 jpkr。但旧数据、旧链接、以及模型
 * （训练语料里那个名字见得多）都还会写出 'tw'，直接丢掉会让一篇台湾的
 * 报道变成「没有地区」。所以先翻译再校验，和网站那边 REGION_ALIAS
 * 做的是同一件事。
 */
export const REGION_ALIAS = { tw: 'jpkr' }

export const REGIONS = new Set([
  'cn', 'hk', 'jpkr', 'us', 'eu', 'anz', 'sea', 'sasia', 'mena', 'ru', 'africa', 'latam', 'global',
])
