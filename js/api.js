// 外部 API アダプタ層（設計書 §4.2）
// すべてフォールバック前提: 失敗しても前回値 + asOf 表示のまま機能を止めない。
// ここから外部に送るのはティッカーシンボルのみ。個人資産データは一切送信しない。
import { todayStr, touch } from './state.js';
import { evaluateTriggers, isJpTicker, recordBenchmark } from './derive.js';

function withTimeout(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  return undefined;
}

// 為替: Frankfurter（無料・キー不要・CORS 可、ECB 公表レート）
export async function fetchFx(state) {
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY', {
      signal: withTimeout(8000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const value = Number(data?.rates?.JPY);
    if (!value) throw new Error('レートが空です');
    state.fx.USDJPY = { value, asOf: data.date, source: 'frankfurter' };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 米国株価: Finnhub（無料枠 60call/分。キーは localStorage 保存）
export async function fetchQuoteFinnhub(ticker, key) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: withTimeout(8000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data || typeof data.c !== 'number' || data.c <= 0) throw new Error('価格が取得できません');
  return { value: data.c, currency: 'USD', asOf: todayStr(), source: 'finnhub' };
}

// USD 建てでティッカーを持つ保有 + ウォッチ銘柄を一括更新。失敗銘柄は前回値のまま。
// 更新後に価格トリガーを自動判定する（Phase 2）。
export async function updateUsPrices(state) {
  const key = state.settings.api.finnhubKey;
  if (!key) return { ok: false, reason: 'no_key', updated: 0, failed: [], fired: 0 };

  const quoteCache = new Map(); // 同一ティッカーの二重取得を避ける
  async function quote(ticker) {
    const t = ticker.toUpperCase();
    if (!quoteCache.has(t)) quoteCache.set(t, await fetchQuoteFinnhub(t, key));
    return quoteCache.get(t);
  }

  const holdingTargets = state.holdings.filter(
    (h) => h.ticker && (h.price?.currency || h.currency) === 'USD'
  );
  const watchTargets = state.watchlist.filter((w) => w.ticker && w.status !== 'passed');

  let updated = 0;
  const failed = [];
  for (const h of holdingTargets) {
    try {
      h.price = { ...(await quote(h.ticker)) };
      touch(h);
      updated++;
    } catch (e) {
      failed.push(h.ticker);
    }
  }
  let updatedWatch = 0;
  for (const w of watchTargets) {
    try {
      w.lastPrice = { ...(await quote(w.ticker)) };
      touch(w);
      updatedWatch++;
    } catch (e) {
      if (!failed.includes(w.ticker)) failed.push(w.ticker);
    }
  }

  // モデルピック（Phase 4）: オープンな米国銘柄ピックの現在価格を更新（日本株は手動）
  const pickTargets = state.modelPicks.filter((p) => p.ticker && !p.exitDate && !isJpTicker(p.ticker));
  let updatedPicks = 0;
  for (const p of pickTargets) {
    try {
      p.lastPrice = { ...(await quote(p.ticker)) };
      touch(p);
      updatedPicks++;
    } catch (e) {
      if (!failed.includes(p.ticker)) failed.push(p.ticker);
    }
  }

  // ベンチマーク SPY を記録（失敗しても欠損として扱うだけで計算は破綻しない）
  try {
    const q = await quote('SPY');
    recordBenchmark(state, 'SPY', q.value, q.asOf);
  } catch (e) { /* 欠損 */ }

  const fired = evaluateTriggers(state);
  return {
    ok: true, updated, updatedWatch, updatedPicks, failed,
    total: holdingTargets.length + watchTargets.length + pickTargets.length, fired,
  };
}
