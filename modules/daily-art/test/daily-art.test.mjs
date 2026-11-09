import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { migrateYandereSettings, startDailyArt } from '../index.mjs'
import { PermanentImageError, probeKonachan, selectKonachan } from '../lib/konachan.mjs'
import { requestKonachan } from '../lib/transport.mjs'

test('Konachan selection skips low scores, repeated IDs, and off-site images', async () => {
  const post = (id, score = 31, sample_url = `/sample/${id}.jpg`) => ({ id, score, sample_url, rating: 's' })
  const pages = [[post(1), post(2, 30), post(3), post(3), post(4, 50, 'https://elsewhere.example/4.jpg')], [post(5)]]
  const result = await selectKonachan(new Set(['konachan:1']), 2, {
    fetchPosts: async url => Response.json(pages[Number(url.searchParams.get('page')) - 1]),
  })
  assert.deepEqual(result.map(p => p.key), ['konachan:3', 'konachan:5'])
})

test('Konachan probe uses account credentials without following redirects or exposing credentials in its result', async () => {
  const credentials = { username: 'test-account', apiKey: 'not-a-real-key' }
  let calls = 0
  const results = await probeKonachan(credentials, { fetchPosts: async (url, request) => {
    calls++
    assert.equal(url.searchParams.get('username'), credentials.username)
    assert.equal(url.searchParams.get('api_key'), credentials.apiKey)
    assert.equal(request.redirect, 'manual')
    if (url.hostname === 'konachan.net') return Response.json([{ id: 1 }])
    return new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } })
  } })
  assert.equal(results[0].ok, true)
  assert.match(results[1].message, /Cloudflare/)
  assert.equal(calls, 2)
  assert.ok(!JSON.stringify(results).includes(credentials.apiKey))
  await probeKonachan({ username: 'test-account', apiKey: '' }, { fetchPosts: async url => {
    assert.equal(url.searchParams.has('api_key'), false)
    assert.equal(url.searchParams.has('username'), false)
    return Response.json([])
  } })
})

test('connection diagnostics retain Cloudflare evidence and omit sensitive request and response data', async () => {
  const lines = []
  const log = { warn: value => lines.push(value), info: value => lines.push(value) }
  await probeKonachan({ username: 'private-account-name', apiKey: 'private-test-key' }, {
    proxyUrl: 'http://user:private-proxy-secret@proxy.example:8080', log, operation: 'connection-test', trace: true,
    fetchPosts: async url => url.hostname === 'konachan.net' ? Response.json([]) : new Response('private-response-body', {
      status: 403,
      headers: { 'cf-mitigated': 'challenge', 'cf-ray': '1234aabbccddeeff-NRT', 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'private-cookie' },
    }),
  })
  const challenge = lines.map(line => JSON.parse(line.slice('[Konachan] '.length))).find(entry => entry.host === 'konachan.com')
  assert.equal(challenge.outcome, 'cloudflare-challenge')
  assert.equal(challenge.status, 403)
  assert.equal(challenge.cfRay, '1234aabbccddeeff-NRT')
  assert.equal(challenge.network, 'proxy')
  assert.equal(challenge.auth, 'api-key')
  assert.doesNotMatch(lines.join('\n'), /private-|proxy\.example|api_key=/)
})

test('rejected Konachan credentials fall back once and the remaining pages use the same proxy', async () => {
  const proxyUrl = 'http://proxy.example:8080'
  const credentials = { username: 'test-account', apiKey: 'expired-key' }
  const calls = []
  const images = await selectKonachan(new Set(), 1, { proxyUrl, credentials, fetchPosts: async (url, request) => {
    assert.equal(request.proxyUrl, proxyUrl)
    assert.match(url.searchParams.get('tags'), /score:31\.\./)
    const page = url.searchParams.get('page')
    const authenticated = url.searchParams.has('api_key')
    calls.push([page, authenticated, url.searchParams.has('username')])
    if (authenticated) return new Response(null, { status: 403 })
    const id = Number(page)
    return Response.json([{ id, rating: 's', score: id === 1 ? 30 : 31, sample_url: `/sample/${id}.jpg` }])
  } })
  assert.deepEqual(calls, [['1', true, true], ['1', false, false], ['2', false, false]])
  assert.deepEqual(images.map(p => p.key), ['konachan:2'])
})

test('configured proxy receives CONNECT and a refused tunnel fails the request', async t => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 5)) {
    await assert.rejects(requestKonachan('https://konachan.net/post.json', { proxyUrl: 'http://127.0.0.1:1' }), /需要 Node\.js 24\.5/)
    return
  }
  const server = createServer()
  const connects = []
  server.on('connect', (req, socket) => {
    connects.push(req.url)
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const proxyUrl = `http://127.0.0.1:${server.address().port}`
  await assert.rejects(requestKonachan('https://konachan.net/post.json', { proxyUrl, signal: AbortSignal.timeout(3000) }))
  assert.deepEqual(connects, ['konachan.net:443'])
})

test('scheduled selection applies the configured filters and rejects unsupported ratings', async () => {
  const filters = {
    min_score: 40, max_score: 90, tags: ['landscape'], exclude_tags: ['text'],
    min_width: 1920, orientation: 'landscape', sort: 'score', rating: 's', advanced: 'ratio:16:9 mpixels:2..',
  }
  const post = (id, overrides = {}) => ({ id, score: 40, tags: 'landscape', rating: 's', width: 1920, height: 1080, sample_url: `/sample/${id}.jpg`, ...overrides })
  const fetchPosts = async url => {
    assert.equal(url.searchParams.get('tags'), 'landscape -text rating:s score:40..90 order:score width:1920.. ratio:16:9 mpixels:2..')
    return Response.json([post(1, { score: 91 }), post(2, { tags: 'landscape text' }), post(3, { rating: 'q' }), post(4, { width: 1080, height: 1920 }), post(5)])
  }
  assert.deepEqual((await selectKonachan(new Set(), 1, { filters, fetchPosts })).map(p => p.key), ['konachan:5'])
  await assert.rejects(selectKonachan(new Set(), 1, { filters: { ...filters, rating: 'q' }, fetchPosts }), /只支持 Safe/)
  await assert.rejects(selectKonachan(new Set(), 1, { filters: { ...filters, advanced: 'width:2000..' }, fetchPosts }), /width 重复/)
})

test('Yande.re selection isolates IDs and credentials and accepts its image CDN', async () => {
  const posts = await selectKonachan(new Set(['konachan:42']), 1, {
    source: 'yandere', proxyUrl: 'http://yande-proxy.example:8080', credentials: { username: 'kona', apiKey: 'other-site-key' },
    fetchPosts: async (url, request) => {
      assert.equal(url.origin, 'https://yande.re')
      assert.equal(url.searchParams.has('api_key'), false)
      assert.equal(request.proxyUrl, 'http://yande-proxy.example:8080')
      return Response.json([
        { id: 40, rating: 'q', score: 99, sample_url: 'https://files.yande.re/sample/40.jpg' },
        { id: 41, rating: 's', score: 99, sample_url: 'https://konachan.net/sample/41.jpg' },
        { id: 42, rating: 's', score: 99, sample_url: 'https://files.yande.re/sample/42.jpg' },
      ])
    },
  })
  assert.deepEqual(posts, [{ key: 'yandere:42', url: 'https://files.yande.re/sample/42.jpg' }])
})

test('Yande.re accepts q and e filters and still checks returned rating', async () => {
  for (const rating of ['q', 'e']) {
    const images = await selectKonachan(new Set(), 1, { source: 'yandere', filters: { rating }, fetchPosts: async url => {
      assert.match(url.searchParams.get('tags'), new RegExp(`rating:${rating}\\b`))
      return Response.json([
        { id: 1, rating: 's', score: 40, sample_url: 'https://files.yande.re/sample/1.jpg' },
        { id: 2, rating, score: 40, sample_url: 'https://files.yande.re/sample/2.jpg' },
      ])
    } })
    assert.equal(images[0].key, 'yandere:2')
  }
})

test('multiple scheduled ratings match any checked rating and exclude all others', async () => {
  const images = await selectKonachan(new Set(), 2, { source: 'yandere', filters: { rating: ['q', 's'] }, fetchPosts: async url => {
    assert.match(url.searchParams.get('tags'), /(?:^|\s)-rating:e(?:\s|$)/)
    return Response.json(['e', 'q', 's'].map((rating, id) => ({ id: id + 1, rating, score: 40, sample_url: `https://files.yande.re/sample/${id}.jpg` })))
  } })
  assert.deepEqual(images.map(p => p.key), ['yandere:2', 'yandere:3'])
})

test('legacy Yande.re settings move into daily-art without overriding the existing proxy', () => {
  const cfg = { ext: {
    'daily-art': { konachanProxyUrl: 'http://shared.example:8080' },
    'daily-art-yandere': { enabled: true, groupWhitelist: '12345', pushTimes: '19:00', yandereProxyUrl: 'http://old.example:8080' },
  }, modules: {} }
  const next = migrateYandereSettings(cfg)
  assert.deepEqual(next.ext['daily-art'].yandere, { enabled: true, groupWhitelist: '12345', pushTimes: '19:00' })
  assert.equal(next.ext['daily-art'].konachanProxyUrl, 'http://shared.example:8080')
  assert.equal(next.ext['daily-art-yandere'], undefined)
  assert.equal(next.modules['daily-art-yandere'].enabled, false)
  assert.equal(migrateYandereSettings(next), next)
})

test('same-day catch-up resumes only failed recipients and keeps IDs across days', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-daily-art-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const config = { enabled: true, dryRun: false, ownerQQ: '34567', allow: { groups: ['45678'], private: ['56789'] } }
  const settings = { enabled: true, groupWhitelist: '', privateWhitelist: '', konachanProxyUrl: 'http://proxy.example:8080' }
  const deliveries = []
  const selections = []
  let moment = Date.parse('2026-11-09T18:00:00+08:00')
  let fail = true
  const api = {
    config: () => config, settings: () => settings, dataDir: name => join(dir, name),
    core: { hub: { sendSegments: async (chat, segments, note) => {
      deliveries.push({ chat, segments, note })
      if (fail && chat === 'private:23456' && note.includes('9:00')) throw Object.assign(new Error('offline'), { transport: true })
      return { message_id: 1 }
    } } },
    log: { info() {}, warn() {} }, onDispose() {}, later() {}, every() {},
  }
  const start = () => startDailyArt(api, {
    now: () => moment,
    select: async (used, count, { filters, proxyUrl }) => {
      assert.equal(proxyUrl, settings.konachanProxyUrl)
      selections.push(filters)
      return Array.from({ length: count }, (_, index) => {
        const id = used.size + index + 1
        return { key: `konachan:${id}`, url: `https://konachan.net/${id}.jpg` }
      })
    },
    download: async (url, { proxyUrl }) => {
      assert.equal(proxyUrl, settings.konachanProxyUrl)
      return Buffer.from(url)
    },
  })
  const tick = start()
  await tick()
  assert.equal(deliveries.length, 0, 'a blank module whitelist does not inherit chat permissions')
  settings.groupWhitelist = '12345，12345\ninvalid'
  settings.privateWhitelist = '23456'
  config.dryRun = true
  await tick()
  assert.equal(deliveries.length, 0)
  config.dryRun = false
  await tick()
  assert.equal(deliveries.length, 4)
  assert.deepEqual(selections.map(f => f.min_score), [31, 31])
  assert.deepEqual(deliveries.map(d => d.chat), ['group:12345', 'private:23456', 'group:12345', 'private:23456'])
  assert.ok(deliveries.every(d => d.segments.length === 5 && d.segments.every(s => s.type === 'image')))
  assert.notDeepEqual(deliveries[0].segments, deliveries[2].segments)
  fail = false
  settings.pushMinScore = 60
  settings.pushTags = 'landscape，sky'
  settings.privateWhitelist = ''
  await start()()
  assert.equal(deliveries.length, 4, 'a removed recipient is skipped even if delivery was pending')
  settings.privateWhitelist = '23456'
  const restart = start()
  await restart()
  assert.deepEqual(deliveries.slice(4), [deliveries[1]])
  settings.pushTimes = '9:30，09:30'
  settings.pushCount = 3
  moment = Date.parse('2026-11-10T09:29:59+08:00')
  await restart()
  assert.equal(deliveries.length, 5)
  moment += 1000
  await restart()
  assert.equal(deliveries.length, 7)
  assert.match(deliveries[5].note, /09:30/)
  assert.equal(deliveries[5].segments.length, 3)
  await start()()
  assert.equal(deliveries.length, 7, 'the minute slot is not resent after restarting')
  assert.equal(deliveries[5].segments[0].data.file, `base64://${Buffer.from('https://konachan.net/11.jpg').toString('base64')}`)
  assert.deepEqual(selections.map(f => f.min_score), [31, 31, 60])
  assert.deepEqual(selections[2].tags, ['landscape', 'sky'])
})

test('a permanently unavailable image is replaced without resending to completed recipients', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-daily-art-repair-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'delivery.json')
  const settings = { enabled: true, pushTimes: '09:00', pushCount: 2, privateWhitelist: '12345,23456' }
  let moment = Date.parse('2026-11-09T09:00:00+08:00')
  let broken = false
  const sends = []
  const api = {
    config: () => ({ enabled: true }), settings: () => settings, dataDir: () => file,
    later() {}, every() {}, onDispose() {}, log: { info() {}, warn() {} },
    core: { hub: { sendSegments: async (id, segments) => {
      sends.push({ id, segments })
      if (id === 'private:23456' && !broken) throw Object.assign(new Error('offline'), { transport: true })
      return { message_id: 9 }
    } } },
  }
  const deps = {
    now: () => moment,
    select: async (used, count) => Array.from({ length: count }, (_, i) => {
      const id = used.size + i + 1
      return { key: `konachan:${id}`, url: `https://konachan.net/${id}.jpg` }
    }),
    download: async url => {
      if (broken && url.endsWith('/1.jpg')) throw new PermanentImageError('HTTP 404')
      return Buffer.from(url)
    },
  }
  await startDailyArt(api, deps)()
  broken = true
  moment += 300_000
  await startDailyArt(api, deps)()
  assert.equal(sends.length, 2)
  const state = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(state.slots['9'].images.map(p => p.key), ['konachan:3', 'konachan:2'])
  assert.deepEqual(state.used, ['konachan:1', 'konachan:2', 'konachan:3'])
  moment += 300_000
  await startDailyArt(api, deps)()
  assert.deepEqual(sends.map(x => x.id), ['private:12345', 'private:23456', 'private:23456'])
  assert.match(Buffer.from(sends.at(-1).segments[0].data.file.slice(9), 'base64').toString(), /\/3\.jpg$/)
})
