// 外部 API アダプタ層（設計書 §4.2）
// すべてフォールバック前提: 失敗しても前回値 + asOf 表示のまま機能を止めない。
// ここから外部に送るのはティッカーシンボルのみ。個人資産データは一切送信しない。
import { todayStr, touch, nowIso } from './state.js';
import { evaluateTriggers, isJpTicker, recordBenchmark, jpCodeOf, JP_AUTO_SOURCE } from './derive.js';

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

// ---- 日本株: yahoo_jp_static（設計書 §4.2 v1.1） ----
// GitHub Actions が生成した同一オリジンの静的 JSON を読むだけ。
// 未配信（404）・オフラインでも黙ってスキップし、手動更新の運用に自然に戻る。

async function fetchStaticJson(path) {
  const res = await fetch(path, { cache: 'no-store', signal: withTimeout(8000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// 対象コード一覧（設定画面で「リストへの追記が必要」を案内するために読む）
export async function fetchJpTickerList() {
  try {
    const data = await fetchStaticJson('./docs/jp-tickers.json');
    const tickers = (data?.tickers || []).map((t) => String(t).trim()).filter(Boolean);
    return { ok: true, tickers };
  } catch (e) {
    return { ok: false, tickers: [] };
  }
}

// 手動値の方が新しければ上書きしない（自動取得はあくまで上乗せ）
function shouldKeepManual(current, asOf) {
  return !!(current && current.source === 'manual' && current.asOf && current.asOf > asOf);
}

export async function updateJpPrices(state) {
  let file;
  try {
    file = await fetchStaticJson('./docs/prices-jp.json');
  } catch (e) {
    return { ok: false, reason: 'unavailable' };
  }
  const prices = file?.prices || {};
  const fileAsOf = file?.asOf || null;

  const entryFor = (ticker) => {
    const code = jpCodeOf(ticker);
    if (!code) return null;
    const e = prices[code];
    if (!e || !(Number(e.close) > 0)) return null;
    return {
      value: Number(e.close),
      currency: e.currency || 'JPY',
      asOf: e.asOf || fileAsOf || todayStr(),
      source: JP_AUTO_SOURCE,
    };
  };

  let updated = 0;
  let updatedWatch = 0;
  let updatedPicks = 0;
  let keptManual = 0;

  for (const h of state.holdings) {
    const next = entryFor(h.ticker);
    if (!next) continue;
    if (shouldKeepManual(h.price, next.asOf)) {
      keptManual++;
      continue;
    }
    if (h.price?.value === next.value && h.price?.asOf === next.asOf && h.price?.source === next.source) continue;
    h.price = next;
    touch(h);
    updated++;
  }

  for (const w of state.watchlist) {
    if (w.status === 'passed') continue;
    const next = entryFor(w.ticker);
    if (!next) continue;
    if (shouldKeepManual(w.lastPrice, next.asOf)) {
      keptManual++;
      continue;
    }
    if (w.lastPrice?.value === next.value && w.lastPrice?.asOf === next.asOf) continue;
    w.lastPrice = next;
    touch(w);
    updatedWatch++;
  }

  // オープンな日本株ピックの現在値（Phase 4。エントリー価格は当時の値なので触らない）
  for (const p of state.modelPicks) {
    if (p.exitDate) continue;
    const next = entryFor(p.ticker);
    if (!next) continue;
    if (shouldKeepManual(p.lastPrice, next.asOf)) {
      keptManual++;
      continue;
    }
    if (p.lastPrice?.value === next.value && p.lastPrice?.asOf === next.asOf) continue;
    p.lastPrice = next;
    touch(p);
    updatedPicks++;
  }

  // 1306（TOPIX 連動 ETF）が対象に含まれていればベンチマークとして記録
  const topix = entryFor('1306');
  if (topix) recordBenchmark(state, '1306', topix.value, topix.asOf);

  state.jpAuto = {
    ...state.jpAuto,
    asOf: fileAsOf,
    fetchedAt: nowIso(),
    count: Object.keys(prices).length,
  };

  const fired = evaluateTriggers(state);
  return {
    ok: true,
    asOf: fileAsOf,
    count: Object.keys(prices).length,
    updated, updatedWatch, updatedPicks, keptManual, fired,
    changed: updated + updatedWatch + updatedPicks > 0,
  };
}

// 対象コード一覧を取り込んで保存（設定画面の案内をオフラインでも出せるようにする）
export async function refreshJpTickerList(state) {
  const r = await fetchJpTickerList();
  if (r.ok) state.jpAuto = { ...state.jpAuto, tickers: r.tickers };
  return r;
}
