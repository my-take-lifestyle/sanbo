#!/usr/bin/env node
// 日本株価格の日次取得（設計書 §4.2 v1.1 / 別紙『実装指示プロンプト_日本株自動取得』）
//
// Yahoo Finance 非公式 API から終値を取得し docs/prices-jp.json を生成する。
// - 依存なし（Node 18+ 組み込みの fetch のみ）
// - 扱う入力は公開銘柄コードだけ。数量・金額・口座などの個人データは一切参照しない
// - 非公式 API のため停止・仕様変更があり得る。失敗時は前回値を維持し、
//   全滅した場合はファイルを書き換えない（アプリは手動更新へ自然に戻る）
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TICKERS_FILE = process.env.JP_TICKERS_FILE || path.join(ROOT, 'docs', 'jp-tickers.json');
const PRICES_FILE = process.env.JP_PRICES_FILE || path.join(ROOT, 'docs', 'prices-jp.json');

const ENDPOINT = 'https://query1.finance.yahoo.com/v8/finance/chart';
const MIN_INTERVAL_MS = 1100; // 受け入れ基準5: リクエスト間隔1秒以上を実装で保証する
const TIMEOUT_MS = 10000;
const RETRIES = 1;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// epoch 秒 → JST の YYYY-MM-DD（ICU に依存しない実装）
export function jstDateFromEpoch(sec) {
  return new Date((Number(sec) + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

// Yahoo のレスポンスから終値・通貨・日付を取り出す。取れなければ例外
export function extractQuote(json) {
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || 'result が空です');
  const meta = result.meta || {};
  const currency = meta.currency || 'JPY';

  const price = Number(meta.regularMarketPrice);
  if (price > 0 && meta.regularMarketTime) {
    return { close: price, currency, asOf: jstDateFromEpoch(meta.regularMarketTime) };
  }

  // フォールバック: 日足系列の最後の非 null 終値
  const closes = result.indicators?.quote?.[0]?.close || [];
  const stamps = result.timestamp || [];
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = Number(closes[i]);
    if (c > 0 && stamps[i]) return { close: c, currency, asOf: jstDateFromEpoch(stamps[i]) };
  }
  throw new Error('終値が取得できません');
}

// 最短間隔を保証するリミッタ（リトライも含めすべての送信がこれを通る）
export function createRateLimiter(minIntervalMs = MIN_INTERVAL_MS) {
  let last = 0;
  return async function acquire() {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

export async function fetchQuote(code, acquire) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    await acquire();
    try {
      const url = `${ENDPOINT}/${encodeURIComponent(code)}.T?range=5d&interval=1d`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return extractQuote(await res.json());
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// 取得本体。quoteFn を差し替えられるのでモックでテストできる（受け入れ基準2）
export async function buildPrices({ tickers, previous, quoteFn, log = console.log }) {
  const prices = {};
  const failed = [];
  let okCount = 0;
  let latestAsOf = null;

  for (const code of tickers) {
    try {
      const q = await quoteFn(code);
      prices[code] = { close: q.close, currency: q.currency, asOf: q.asOf };
      okCount++;
      if (!latestAsOf || q.asOf > latestAsOf) latestAsOf = q.asOf;
      log(`  ok   ${code}: ${q.close} ${q.currency} (${q.asOf})`);
    } catch (e) {
      failed.push(code);
      const prev = previous?.prices?.[code];
      if (prev) {
        // 欠損で上書きしない: 前回値を asOf ごと維持する
        prices[code] = { ...prev, asOf: prev.asOf || previous.asOf };
        log(`  keep ${code}: 取得失敗（${e.message}）→ 前回値 ${prev.close} (${prices[code].asOf}) を維持`);
      } else {
        log(`  miss ${code}: 取得失敗（${e.message}）→ 前回値なし`);
      }
    }
  }

  return {
    prices,
    asOf: latestAsOf || previous?.asOf || null,
    okCount,
    failed,
  };
}

async function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    console.warn(`! ${path.basename(file)} を読めませんでした: ${e.message}`);
    return null;
  }
}

async function main() {
  const config = await readJson(TICKERS_FILE);
  const tickers = [...new Set((config?.tickers || []).map((t) => String(t).trim()).filter(Boolean))];
  const previous = await readJson(PRICES_FILE);

  if (tickers.length === 0) {
    console.log('銘柄リストが空です（docs/jp-tickers.json）。何もせず終了します。');
    return;
  }
  console.log(`対象 ${tickers.length} 銘柄を順次取得します（間隔 ${MIN_INTERVAL_MS}ms 以上）`);

  const acquire = createRateLimiter();
  const built = await buildPrices({
    tickers,
    previous,
    quoteFn: (code) => fetchQuote(code, acquire),
  });

  if (built.okCount === 0) {
    // 全滅（API 停止・仕様変更など）。ファイルを触らずに警告付きで正常終了する
    console.warn(`! 全 ${tickers.length} 銘柄で取得に失敗しました。${path.basename(PRICES_FILE)} は変更しません（前回値のまま）。`);
    console.warn('! 継続する場合は Yahoo 側の仕様変更を確認してください。アプリは手動更新で運用を継続できます。');
    return;
  }

  const next = {
    asOf: built.asOf,
    source: 'yahoo-unofficial',
    generatedAt: new Date().toISOString(),
    prices: built.prices,
  };

  // 差分がある時だけ書く（generatedAt は比較から除外し、無意味な commit を防ぐ）
  const comparable = (o) => JSON.stringify({ asOf: o?.asOf, source: o?.source, prices: o?.prices });
  if (previous && comparable(previous) === comparable(next)) {
    console.log('内容に変化がないため書き込みません。');
    return;
  }

  await writeFile(PRICES_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`書き込みました: ${path.basename(PRICES_FILE)}（成功 ${built.okCount}/${tickers.length}、asOf ${next.asOf}）`);
  if (built.failed.length) console.log(`  取得失敗（前回値維持）: ${built.failed.join(', ')}`);
}

// 直接実行時のみ main（テストから import した場合は実行しない）
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  main().catch((e) => {
    console.error('想定外のエラー:', e);
    process.exit(1);
  });
}
