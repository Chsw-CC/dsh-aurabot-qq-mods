// 新功能的测试：分区（新接口+缓存+自动挑选）、话题（活动+普通+热度+搜索+互斥）、
// 每天每篇排期、每日羊毛风格、配图三处位置。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, ok, json } from './helpers.mjs'

// ── 分区 ──────────────────────────────────────────────────────

test('分区：从 /topic/categories 抽三组，去重并保留热度/游戏标记', async () => {
  const categories = {
    recommend_for_user_topics: { name: '为你推荐', children: [
      { topic_id: 18745, name: '数码硬件', hot: { raw_hot_value: 100 }, game: { app_id: 1 } },
    ] },
    latest_hot_topics: { name: '近期热门', children: [
      { topic_id: 18745, name: '数码硬件', hot: { raw_hot_value: 9999 }, game: { app_id: 1 } },
      { topic_id: 7214, name: '盒友杂谈', hot: { raw_hot_value: 500 } },
      { topic_id: 733575, name: '影之刃零', hot: { raw_hot_value: 800 }, game: { app_id: 2 } },
    ] },
    subscribed_topics: { name: '我的偏好', children: [] },
  }
  const f = fixture({
    fetcher: async (url) => {
      if (String(url).includes('/bbs/app/topic/categories')) return ok(categories)
      return ok({})
    },
  })
  const r = await f.hb.refreshTopics(true)
  const ids = r.list.map((t) => t.id)
  assert.deepEqual(ids.sort(), ['18745', '7214', '733575'])
  const d = r.list.find((t) => t.id === '18745')
  assert.equal(d.hot, 9999, '同一分区出现在多组时保留更大热度')
  assert.equal(d.game, true)
  f.close()
})

test('分区：当天走缓存，force 才重拉', async () => {
  let calls = 0
  const f = fixture({
    fetcher: async (url) => {
      if (String(url).includes('/bbs/app/topic/categories')) {
        calls += 1
        return ok({ latest_hot_topics: { name: '热门', children: [{ topic_id: 7214, name: '盒友杂谈' }] } })
      }
      return ok({})
    },
  })
  await f.hb.refreshTopics(true)
  assert.equal(calls, 1)
  const cached = await f.hb.refreshTopics(false)
  assert.equal(cached.cached, true)
  assert.equal(calls, 1, '同一天内不再请求')
  await f.hb.refreshTopics(true)
  assert.equal(calls, 2, 'force 会重拉')
  f.close()
})

test('分区：接口拿不到时回落内置三个', async () => {
  const f = fixture({ fetcher: async () => json({ status: 'failed' }) })
  const r = await f.hb.refreshTopics(true)
  assert.equal(r.fallback, true)
  assert.equal(r.list.length, 3)
  f.close()
})

test('分区：手动模式永远用默认分区', async () => {
  const f = fixture({
    config: { heybox: { topicMode: 'manual', defaultTopic: '7214' } },
    fetcher: async (url) => {
      if (String(url).includes('/bbs/app/topic/categories')) {
        return ok({ latest_hot_topics: { name: '热门', children: [{ topic_id: 568547, name: '黑神话：悟空', game: { app_id: 3 } }] } })
      }
      return ok({})
    },
  })
  await f.hb.refreshTopics(true)
  const id = await f.hb.pickTopicFor('黑神话：悟空 的新 DLC 出了', '7214')
  assert.equal(id, '7214', '手动模式不自动挑')
  f.close()
})

test('分区：自动模式按内容匹配，挑不到回落', async () => {
  const cats = { latest_hot_topics: { name: '热门', children: [
    { topic_id: 568547, name: '黑神话：悟空', game: { app_id: 3 }, hot: { raw_hot_value: 100 } },
    { topic_id: 425422, name: 'Steam', game: { app_id: 4 }, hot: { raw_hot_value: 200 } },
    { topic_id: 806933, name: 'AI', hot: { raw_hot_value: 300 } },
  ] } }
  const f = fixture({
    config: { heybox: { topicMode: 'auto', defaultTopic: '7214' } },
    fetcher: async (url) => {
      if (String(url).includes('/bbs/app/topic/categories')) return ok(cats)
      return ok({})
    },
  })
  await f.hb.refreshTopics(true)
  assert.equal(await f.hb.pickTopicFor('黑神话：悟空 新 DLC', '7214'), '568547')
  assert.equal(await f.hb.pickTopicFor('Steam 秋季特卖', '7214'), '425422')
  assert.equal(await f.hb.pickTopicFor('今天吃了碗白米饭', '7214'), '7214', '不匹配回落默认')
  // 更长的分区名优先：不因为「AI」二字误配到 AI 分区
  assert.equal(await f.hb.pickTopicFor('这个 AI 游戏叫黑神话：悟空', '7214'), '568547')
  f.close()
})

// ── 话题 ──────────────────────────────────────────────────────

test('话题：扫信息流收集活动与普通话题，活动带 end_ts 过滤', async () => {
  // module 用的是 fixture 注入的 now()（固定 2026-06-08 10:00）
  const fixtureNow = new Date(2026, 5, 8, 10).getTime()
  const feeds = { links: [
    { hashtags: [{ hashtag_id: 1001, name: '活动A', sub_title: '活动' }] },
    { hashtags: [{ hashtag_id: 2001, name: '普通1' }, { hashtag_id: 2002, name: '普通2' }] },
    { hashtags: [{ hashtag_id: 1002, name: '过期活动', sub_title: '活动' }] },
  ] }
  const f = fixture({
    fetcher: async (url) => {
      const u = String(url)
      if (u.includes('/bbs/app/feeds')) return ok(feeds)
      if (u.includes('/bbs/app/hashtag/feeds')) {
        const m = u.match(/hashtag_id=(\d+)/)
        const id = m ? m[1] : ''
        if (id === '1002') return ok({ hashtag: { act_prop: { end_ts: Math.floor(fixtureNow / 1000) - 60 } } })
        return ok({
          hashtag: { is_act_hashtag: 1, num: { content_num: 5000 }, act_prop: { end_ts: Math.floor(fixtureNow / 1000) + 3600 } },
          related_act_info: { title: '活动全名' },
        })
      }
      return ok({})
    },
  })
  const r = await f.hb.refreshActs(true)
  const actNames = r.list.map((a) => a.name)
  assert.ok(actNames.includes('活动A'), '进行中的活动保留')
  assert.ok(!actNames.includes('过期活动'), '过期的活动被过滤')
  assert.equal(r.list[0].actTitle, '活动全名')
  assert.ok(r.plain.some((p) => p.name === '普通1') || r.plain.length > 0, '普通话题也收进来了')
  assert.equal(r.list.every((a) => a.isAct === true), true)
  assert.equal(r.plain.every((a) => a.isAct === false), true)
  f.close()
})

test('话题：列表活动在前、都带热度，搜索按关键词且活动优先', async () => {
  const f = fixture({
    initialState: {
      acts: { date: new Date().toISOString().slice(0, 10), fetchedAt: 1, list: [
        { id: '1001', name: '活动A', actTitle: '活动甲', contentNum: 5000, seen: 2, isAct: true },
      ], plain: [
        { id: '2001', name: '普通游戏1', contentNum: 9000, seen: 3, isAct: false },
        { id: '2002', name: '普通2', contentNum: 8000, seen: 2, isAct: false },
      ] },
    },
  })
  const al = await f.hb.actList()
  assert.equal(al.list.length, 3)
  assert.equal(al.list[0].isAct, true, '活动排最前')
  assert.match(al.message, /【创作活动】/)
  assert.match(al.message, /【普通话题】/)
  assert.match(al.message, /热度/)

  const s1 = await f.hb.searchTopics('游戏')
  assert.ok(s1.list.length > 0)
  assert.ok(s1.list.every((t) => t.name.includes('游戏') || t.actTitle.includes('游戏')))
  const s2 = await f.hb.searchTopics('不存在的词')
  assert.equal(s2.list.length, 0)
  const s3 = await f.hb.searchTopics('')
  assert.ok(s3.list.length > 0, '空关键词返回全部')
  f.close()
})

test('话题：活动与普通互斥；活动限 1 个、普通限 3 个', async () => {
  const f = fixture({
    initialState: {
      acts: { date: new Date().toISOString().slice(0, 10), fetchedAt: 1, list: [
        { id: '1001', name: '活动A', isAct: true, contentNum: 1 },
        { id: '1002', name: '活动B', isAct: true, contentNum: 1 },
      ], plain: [
        { id: '2001', name: '普通1', isAct: false, contentNum: 1 },
        { id: '2002', name: '普通2', isAct: false, contentNum: 1 },
        { id: '2003', name: '普通3', isAct: false, contentNum: 1 },
        { id: '2004', name: '普通4', isAct: false, contentNum: 1 },
      ] },
    },
  })
  // 活动 + 普通 → 只剩活动（互斥）
  const r1 = await f.hb.resolveHashtags(['活动A', '普通1', '普通2'])
  assert.deepEqual(r1, ['1001'])

  // 普通在前 + 活动 → 仍只剩活动
  const r2 = await f.hb.resolveHashtags(['普通1', '活动A'])
  assert.deepEqual(r2, ['1001'])

  // 两个活动 → 只留一个
  const r3 = await f.hb.resolveHashtags(['活动A', '活动B'])
  assert.deepEqual(r3, ['1001'])

  // 4 个普通 → 只留 3 个
  const r4 = await f.hb.resolveHashtags(['普通1', '普通2', '普通3', '普通4'])
  assert.equal(r4.length, 3)

  // 纯普通 / 纯活动都正常
  assert.deepEqual(await f.hb.resolveHashtags(['普通1']), ['2001'])
  assert.deepEqual(await f.hb.resolveHashtags(['活动A']), ['1001'])

  // 不存在的话题被拒
  assert.deepEqual(await f.hb.resolveHashtags(['完全不存在']), [])
  f.close()
})

// ── 每天每篇排期 ──────────────────────────────────────────────

test('排期：按今天第几篇取配置，用完回落全局', async () => {
  const plan = [
    { style: 'deal', topic: '', hashtags: ['活动A'], wordsMin: 150, wordsMax: 300, hint: '写养鱼' },
    { style: 'news', topic: '18745', hashtags: [], wordsMin: 200, wordsMax: 600, hint: '' },
  ]
  const base = { heybox: { enabled: true, postStyle: 'mix', defaultTopic: '7214', dailyPosts: plan } }

  for (const [done, wantStyle, wantTopic] of [[0, 'deal', ''], [1, 'news', '18745']]) {
    const f = fixture({ config: base, initialState: { quota: { date: '2026-06-08', post: done, like: 0, comment: 0, browse: 0, share: 0 } } })
    const p = f.hb.currentPostPlan()
    assert.equal(p.style, wantStyle)
    assert.equal(p.topic, wantTopic)
    assert.equal(p.fromPlan, true)
    f.close()
  }

  // 第 3 篇：排期用完 → 回落全局
  const f3 = fixture({ config: base, initialState: { quota: { date: '2026-06-08', post: 2, like: 0, comment: 0, browse: 0, share: 0 } } })
  const p3 = f3.hb.currentPostPlan()
  assert.equal(p3.fromPlan, false)
  assert.equal(p3.style, 'mix')
  f3.close()
})

test('排期：postPlanState 反映配了几篇、已发几篇、当前第几篇', async () => {
  const plan = [{ style: 'deal' }, { style: 'news' }, { style: 'mix' }]
  const f = fixture({
    config: { heybox: { dailyPosts: plan } },
    initialState: { quota: { date: '2026-06-08', post: 1, like: 0, comment: 0, browse: 0, share: 0 } },
  })
  const st = f.hb.postPlanState()
  assert.equal(st.configured, 3)
  assert.equal(st.done, 1)
  assert.equal(st.current.style, 'news')
  assert.equal(st.items[0].done, true)
  assert.equal(st.items[1].done, false)
  f.close()
})

// ── 风格 ──────────────────────────────────────────────────────

test('风格：有「每日羊毛」，且要求直达链接、不许编造', async () => {
  const { POST_STYLES, stylePrompt } = await import('../lib/styles.mjs')
  assert.ok(POST_STYLES.deal, '有 deal 风格')
  assert.equal(POST_STYLES.deal.needLink, true)

  const withLinks = stylePrompt('deal', { links: ['https://www.xiaoheihe.cn/app/bbs/activity/1'] })
  assert.match(withLinks, /必须给直达链接/)
  assert.match(withLinks, /不许自己编造或拼凑 URL/)
  assert.match(withLinks, /activity\/1/)

  const noLinks = stylePrompt('deal', {})
  assert.match(noLinks, /没有就别发这贴/, '没链接时劝退')

  // 所有风格都要求首段自我介绍
  for (const id of ['diary', 'news', 'mix', 'deal']) {
    const t = stylePrompt(id, { owner: '主人' })
    assert.match(t, /开头第一段固定是自我介绍/, `${id} 要自我介绍`)
  }
})

test('风格：字数范围可被面板覆盖', async () => {
  const { styleOf } = await import('../lib/styles.mjs')
  assert.equal(styleOf('mix').words[1], 500, '默认用风格自带')
  const c = styleOf('mix', { postWordsMin: 300, postWordsMax: 900 })
  assert.deepEqual(c.words, [300, 900])
  assert.equal(c.customWords, true)
  // min>max 或非法值不生效
  assert.equal(styleOf('mix', { postWordsMin: 900, postWordsMax: 300 }).words[1], 500)
  assert.equal(styleOf('diary', { postWordsMin: 'x', postWordsMax: 'y' }).words[0], 120)
})

// ── 配图位置 ──────────────────────────────────────────────────

test('配图：长文首段后有图、文中可插、文末有图', async () => {
  // 造一张最小 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const longText = '我是主人养的大肥鱼，在小黑盒陪盒友聊游戏。\n\n第二段讲背景。\n\n第三段给数据。\n\n' + '补充内容凑字数。'.repeat(75) + '\n\n末尾抛问题。'
  const f = fixture({
    config: { heybox: { enabled: true, cookie: 'pkey=x; heybox_id=1', postStyle: 'mix', maxPostsPerDay: 99 } },
    fetcher: async (url, opt) => {
      const u = String(url)
      if (u.includes('upload/info')) return ok({ keys: ['/k.png'], bucket: 'b', region: 'r' })
      if (u.includes('upload/token')) return ok({ credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 's' } })
      if (u.includes('upload/callback')) return ok({ preview_urls: ['https://img/x.png'] })
      if (u.startsWith('https://b.cos.r.myqcloud.com')) return new Response('', { status: 200 })
      return ok({ link_id: '195429579' })
    },
  })
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const imgDir = mkdtempSync(join(tmpdir(), 'heybox-img-'))
    const intro = join(imgDir, 'intro.png')
    const inline = join(imgDir, 'inline.png')
    const tail = join(imgDir, 'tail.png')
    writeFileSync(intro, png); writeFileSync(inline, png); writeFileSync(tail, png)

    const r = await f.hb.post({ title: '长文测试', text: longText, imagesByPos: { intro: [intro], inline: [inline], tail: [tail] } })
    assert.equal(r.ok, true)
    assert.equal(r.images.intro, 1)
    assert.equal(r.images.inline, 1)
    assert.equal(r.images.tail, 1)
    assert.equal(r.images.total, 3)
    assert.equal(r.introSkipped, false)
    f.close()
})

test('配图：短文（<500字）不放首图，文末图照旧', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const shortText = '我是主人养的大肥鱼。\n\n这段很短。'
  const f = fixture({
    config: { heybox: { enabled: true, cookie: 'pkey=x; heybox_id=1', postStyle: 'mix', maxPostsPerDay: 99 } },
    fetcher: async (url) => {
      const u = String(url)
      if (u.includes('upload/info')) return ok({ keys: ['/k.png'], bucket: 'b', region: 'r' })
      if (u.includes('upload/token')) return ok({ credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 's' } })
      if (u.includes('upload/callback')) return ok({ preview_urls: ['https://img/x.png'] })
      if (u.startsWith('https://b.cos.r.myqcloud.com')) return new Response('', { status: 200 })
      return ok({ link_id: '1' })
    },
  })
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const imgDir = mkdtempSync(join(tmpdir(), 'heybox-img-'))
  const intro = join(imgDir, 'intro.png')
  const tail = join(imgDir, 'tail.png')
  writeFileSync(intro, png); writeFileSync(tail, png)

  const r = await f.hb.post({ title: '短文测试', text: shortText, imagesByPos: { intro: [intro], tail: [tail] } })
  assert.equal(r.images.intro, 0, '短文不放首图')
  assert.equal(r.images.tail, 1)
  assert.equal(r.introSkipped, true)
  f.close()
})

test('配图：旧参数 images 当文末图（兼容老调用）', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const f = fixture({
    config: { heybox: { enabled: true, cookie: 'pkey=x; heybox_id=1', postStyle: 'mix', maxPostsPerDay: 99 } },
    fetcher: async (url) => {
      const u = String(url)
      if (u.includes('upload/info')) return ok({ keys: ['/k.png'], bucket: 'b', region: 'r' })
      if (u.includes('upload/token')) return ok({ credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 's' } })
      if (u.includes('upload/callback')) return ok({ preview_urls: ['https://img/x.png'] })
      if (u.startsWith('https://b.cos.r.myqcloud.com')) return new Response('', { status: 200 })
      return ok({ link_id: '1' })
    },
  })
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const imgDir = mkdtempSync(join(tmpdir(), 'heybox-img-'))
  const p = join(imgDir, 'a.png')
  writeFileSync(p, png)
  const r = await f.hb.post({ title: '旧参数', text: '正文'.repeat(300), images: [p] })
  assert.equal(r.images.tail, 1)
  f.close()
})
