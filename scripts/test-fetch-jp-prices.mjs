#!/usr/bin/env node
// fetch-jp-prices.mjs のモックテスト（`npm run test-jp` で実行）
// 受け入れ基準2（全滅しても前回値を維持）と5（リクエスト間隔1秒以上）を検証する。
import assert from 'node:assert/strict';
import {
  buildPrices, extractQuote, jstDateFromEpoch, createRateLimiter,
} from './fetch-jp-prices.mjs';

const silent = () => {};
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const PREVIOUS = {
  asOf: '2026-09-03',
  source: 'yahoo-unofficial',
  prices: {
    7203: { close: 3081, currency: 'JPY', asOf: '2026-09-03' },
    6501: { close: 4200, currency: 'JPY', asOf: '2026-09-02' },
  },
};

console.log('fetch-jp-prices のテスト');

await test('全銘柄が失敗しても前回値と asOf を維持する', async () => {
  const r = await buildPrices({
    tickers: ['7203', '6501'],
    previous: PREVIOUS,
    quoteFn: async () => { throw new Error('mock: API 停止'); },
    log: silent,
  });
  assert.equal(r.okCount, 0);
  assert.deepEqual(r.failed, ['7203', '6501']);
  assert.equal(r.prices['7203'].close, 3081);
  assert.equal(r.prices['7203'].asOf, '2026-09-03', '前回の asOf が維持されること');
  assert.equal(r.prices['6501'].asOf, '2026-09-02', '銘柄ごとの asOf が保たれること');
  assert.equal(r.asOf, '2026-09-03', 'ファイル全体の asOf も前回値のまま');
});

await test('一部失敗: 成功分は更新、失敗分は前回値を維持', async () => {
  const r = await buildPrices({
    tickers: ['7203', '6501'],
    previous: PREVIOUS,
    quoteFn: async (code) => {
      if (code === '6501') throw new Error('mock: この銘柄だけ失敗');
      return { close: 3150, currency: 'JPY', asOf: '2026-09-04' };
    },
    log: silent,
  });
  assert.equal(r.okCount, 1);
  assert.equal(r.prices['7203'].close, 3150);
  assert.equal(r.prices['7203'].asOf, '2026-09-04');
  assert.equal(r.prices['6501'].close, 4200, '失敗銘柄は欠損で上書きされない');
  assert.equal(r.prices['6501'].asOf, '2026-09-02');
  assert.equal(r.asOf, '2026-09-04', 'ファイルの asOf は成功分の最新日');
});

await test('前回値が無い銘柄の失敗はキーごと落とす（欠損を捏造しない）', async () => {
  const r = await buildPrices({
    tickers: ['9999'],
    previous: PREVIOUS,
    quoteFn: async () => { throw new Error('mock: 未知の銘柄'); },
    log: silent,
  });
  assert.equal(r.prices['9999'], undefined);
  assert.equal(r.okCount, 0);
});

await test('リクエスト間隔が1秒以上空く', async () => {
  const acquire = createRateLimiter(1000);
  const stamps = [];
  for (let i = 0; i < 3; i++) {
    await acquire();
    stamps.push(Date.now());
  }
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1];
    assert.ok(gap >= 999, `${i} 回目の間隔が ${gap}ms（1000ms 以上であること）`);
  }
});

await test('extractQuote: meta の終値と JST 日付を採る', () => {
  const q = extractQuote({
    chart: { result: [{ meta: { currency: 'JPY', regularMarketPrice: 3081, regularMarketTime: 1788503400 } }] },
  });
  assert.equal(q.close, 3081);
  assert.equal(q.currency, 'JPY');
  assert.match(q.asOf, /^\d{4}-\d{2}-\d{2}$/);
});

await test('extractQuote: meta が欠けたら日足系列の最終終値にフォールバック', () => {
  const q = extractQuote({
    chart: {
      result: [{
        meta: { currency: 'JPY' },
        timestamp: [1788330600, 1788417000],
        indicators: { quote: [{ close: [3117, 3081] }] },
      }],
    },
  });
  assert.equal(q.close, 3081);
});

await test('extractQuote: 取得不能なら例外', () => {
  assert.throws(() => extractQuote({ chart: { result: [{ meta: {} }] } }));
  assert.throws(() => extractQuote({ chart: { error: { description: 'Not Found' } } }));
});

await test('jstDateFromEpoch: UTC 深夜が翌日の JST 日付になる', () => {
  // 2026-09-04T16:00:00Z = 2026-09-05 01:00 JST
  assert.equal(jstDateFromEpoch(Date.UTC(2026, 8, 4, 16, 0, 0) / 1000), '2026-09-05');
});

console.log(`\n${passed} 件すべて成功`);
