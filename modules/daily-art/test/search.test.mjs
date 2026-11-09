import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { searchKonachan } from '../lib/konachan.mjs'
import { registerSearch } from '../lib/search.mjs'

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5) }
  assert.fail('队列未完成')
}

test('requests retain original rating and sender through queueing, replay, selection and revocation', async () => {
  const cfg = { enabled: true, ownerQQ: '11', allow: { groups: ['20', '21'], private: ['22'] } }
  const settings = { allowPrivateWhitelistSearch: true }
  const replies = [], sends = [], queries = []
  let handler, resolveFirst
  const first = new Promise(resolve => { resolveFirst = resolve })
  registerSearch({
    config: () => cfg, settings: () => settings, log: {}, onDispose() {}, on(_event, fn) { handler = fn },
    ask: ({ text }) => text === '普通图' ? first : Promise.resolve('{"intent":"search","rating":"e","chatId":"private:other","count":1}'),
    reply: async (msg, text) => replies.push([msg.messageId, text]),
    core: { hub: { sendSegments: async (id, data, _note, opts) => {
      if (opts.isCurrent()) sends.push([id, Buffer.from(data[0].data.file.slice(9), 'base64').toString()])
      return { message_id: 1 }
    } } },
  }, {
    search: async ({ rating: [rating] }) => {
      queries.push(rating)
      return [{ url: rating, rating, score: 31, width: 10, height: 10, tags: [], post_url: 'https://yande.re/post/show/1' }]
    },
    download: async url => { if (url === 'q') cfg.allow.groups = []; return Buffer.from(url) },
  })
  const message = (messageId, text, userId = '11', groupId = '20') => ({ kind: 'group', chatId: `group:${groupId}`, groupId, userId, messageId, text })
  const safe = message('1', 'yande找图 普通图')
  assert.equal(await handler(safe), true)
  await handler(message('2', 'yande找图 rating:e 先列候选'))
  await handler(safe)
  resolveFirst('{"intent":"search","rating":"e","source":"konachan"}')
  await waitFor(() => replies.length === 2)
  assert.deepEqual(queries, ['s', 'e'])
  assert.deepEqual(sends, [['group:20', 's']])
  await handler(message('3', 'yande找图 rating:e 发第1张', '12'))
  await handler(message('4', 'yande找图 rating:e 发第1张', '11', '21'))
  await waitFor(() => replies.length === 4)
  assert.equal(sends.length, 1)
  await handler(message('5', 'yande找图 rating:e 发第1张'))
  await waitFor(() => replies.length === 5)
  assert.deepEqual(sends.at(-1), ['group:20', 'e'])
  await handler(message('6', 'yande找图 rating:q 横图'))
  await waitFor(() => cfg.allow.groups.length === 0)
  assert.equal(sends.length, 2)
  settings.allowPrivateWhitelistSearch = false
  assert.equal(await handler({ kind: 'private', chatId: 'private:22', userId: '22', messageId: '7', text: 'yande找图 横图' }), false)
})

test('owner searches multiple ratings in one request and selects only from the same rating set', async () => {
  const cfg = { enabled: true, ownerQQ: '11', allow: { private: ['11', '22'] } }
  const replies = new Map(), requests = [], prompts = [], sends = []
  let handler, revokeOnDownload = false
  registerSearch({
    config: () => cfg, settings: () => ({ allowPrivateWhitelistSearch: true }), log: {}, onDispose() {},
    on(_event, fn) { handler = fn },
    ask: async ({ text }) => { prompts.push(text); return '{"intent":"search","rating":["e"],"sort":"score","count":2}' },
    reply: async (msg, text) => replies.set(msg.messageId, text),
    core: { hub: { sendSegments: async (chatId, segments, _note, opts) => {
      assert.equal(opts.isCurrent(), true)
      sends.push([chatId, segments.map(segment => Buffer.from(segment.data.file.slice(9), 'base64').toString())])
      return { message_id: 1 }
    } } },
  }, {
    search: (args, options) => searchKonachan(args, { ...options, fetchPosts: async url => {
      requests.push(url.searchParams.get('tags'))
      if (url.searchParams.get('page') !== '1') return Response.json([])
      return Response.json(['e', 'q', 's'].map((rating, i) => ({
        id: i + 1, rating, score: 50 - i, width: 20, height: 10, sample_url: `https://files.yande.re/sample/${rating}.jpg`,
      })))
    } }),
    download: async url => {
      if (revokeOnDownload) { cfg.ownerQQ = '33'; revokeOnDownload = false }
      return Buffer.from(new URL(url).pathname)
    },
  })
  const send = async (messageId, text, userId = '11') => {
    assert.equal(await handler({ kind: 'private', chatId: `private:${userId}`, userId, messageId, text }), true)
    await waitFor(() => replies.has(messageId))
    return replies.get(messageId)
  }

  assert.match(await send('1', 'yande找图 rating:s,q 风景', '22'), /只有主人/)
  assert.match(await send('2', 'konachan找图 rating:s,q 风景'), /只支持 Safe/)
  assert.match(await send('3', 'yande找图 rating:s,,q 风景'), /格式无效/)
  assert.match(await send('4', 'yande找图 rating:s,x 风景'), /不支持/)
  assert.deepEqual(prompts, [])
  assert.deepEqual(requests, [])

  const preview = await send('5', 'yande找图 rating:s,q 先列候选')
  assert.match(preview, /1\. q · [\s\S]*2\. s · /)
  assert.doesNotMatch(preview, /\. e · /)
  assert.match(preview, /yande找图 rating:s,q 发第 1 张/)
  assert.deepEqual(prompts, ['先列候选'])
  assert.equal(requests[0], '-rating:e score:0.. order:score')
  assert.match(await send('6', 'yande找图 rating:q 发第1张'), /没有可发送的候选/)
  assert.match(await send('7', 'yande找图 发第1张'), /没有可发送的候选/)
  assert.deepEqual(sends, [])
  await send('8', 'yande找图 rating:q,s 发第1张')
  assert.deepEqual(sends, [['private:11', ['/sample/q.jpg']]])

  await send('9', 'yande找图 rating:s,q 风景')
  assert.deepEqual(sends.at(-1), ['private:11', ['/sample/q.jpg', '/sample/s.jpg']])
  await send('10', 'yande找图 rating:q，风景')
  assert.equal(prompts.at(-1), '风景')
  assert.deepEqual(sends.at(-1), ['private:11', ['/sample/q.jpg']])
  await send('11', 'yande找图 rating:s,q,e 风景')
  assert.deepEqual(sends.at(-1), ['private:11', ['/sample/e.jpg', '/sample/q.jpg']])

  const sentBeforeRevocation = sends.length
  revokeOnDownload = true
  assert.equal(await handler({ kind: 'private', chatId: 'private:11', userId: '11', messageId: '12', text: 'yande找图 rating:s,q 风景' }), true)
  await send('13', 'yande找图 风景')
  assert.equal(sends.length, sentBeforeRevocation + 1)
  assert.deepEqual(sends.at(-1), ['private:11', ['/sample/s.jpg']])
})
