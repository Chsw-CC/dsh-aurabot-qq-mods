import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakePreference, matchWakePrefix } from '../lib/speaker/wake.mjs';

test('only main names and variants trigger; greeting-only legacy names are ignored without rewriting data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xiaoai-wake-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'wake.json');
  const original = JSON.stringify({ schema: 1, names: ['小伴', '小半'], greetingNames: ['旧称'] });
  await writeFile(file, original);
  const preference = new WakePreference(file); await preference.open();
  for (const text of ['小伴天气', '小半天气', '你好小伴天气', '小爱同学小伴天气']) {
    assert.ok(matchWakePrefix(text, preference.get()));
  }
  for (const text of ['你好旧称天气', '旧称天气', '你好天气', '今天天气']) {
    assert.equal(matchWakePrefix(text, preference.get()), null);
  }
  assert.equal(await readFile(file, 'utf8'), original);
  await preference.save({ names: ['小伴', '小半'], greetingNames: [] });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).greetingNames, []);
});
