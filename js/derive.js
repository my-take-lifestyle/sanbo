// 派生値の計算層。評価額は保存せず常に quantity × price × 為替 から導出する（設計書 §1.3）
import { newEntity, todayStr } from './state.js';

export const ASSET_CLASSES = {
  cash: '現金',
  jp_equity: '日本株',
  us_equity: '米国株',
  fund_nisa: '投信（NISA）',
  gold: '金',
  silver: '銀',
  mmf_usd: 'MMF（USD）',
  other: 'その他',
};

// 待機資金 = 現金 + MMF（設計書 §1.4）
export const IDLE_CLASSES = ['cash', 'mmf_usd'];

export const CHART_COLORS = [
  '#4f8cff', '#3ecf8e', '#ffb454', '#ff6b6b',
  '#b78cff', '#4fd6d2', '#f77fb0', '#9aa5b8',
  '#7fd17f', '#e0c060', '#6fa8dc', '#c98f8f',
];

export function fxRate(state) {
  return state.fx?.USDJPY?.value ?? null;
}

export function holdingValueJpy(h, state) {
  const qty = Number(h.quantity) || 0;
  const price = Number(h.price?.value) || 0;
  const cur = h.price?.currency || h.currency || 'JPY';
  let v = qty * price;
  if (cur === 'USD') v *= fxRate(state) || 0;
  return v;
}

// 取得原価の円換算（概算。損益表示用）
export function holdingCostJpy(h, state) {
  const qty = Number(h.quantity) || 0;
  const cost = Number(h.avgCostLocal) || 0;
  if (cost <= 0) return null;
  let v = qty * cost;
  if ((h.currency || 'JPY') === 'USD') v *= fxRate(state) || 0;
  return v;
}

export function totals(state) {
  let total = 0;
  const byClass = {};
  for (const k of Object.keys(ASSET_CLASSES)) byClass[k] = 0;
  const byTheme = {}; // themeId → 円。複数テーマは均等按分。未分類は "_none"
  for (const h of state.holdings) {
    const v = holdingValueJpy(h, state);
    total += v;
    const cls = ASSET_CLASSES[h.assetClass] ? h.assetClass : 'other';
    byClass[cls] += v;
    const tids = (h.themeIds || []).filter((id) => state.themes.some((t) => t.id === id));
    if (tids.length === 0) {
      byTheme._none = (byTheme._none || 0) + v;
    } else {
      for (const id of tids) byTheme[id] = (byTheme[id] || 0) + v / tids.length;
    }
  }
  return { total, byClass, byTheme };
}

export function idleCash(state) {
  const { total, byClass } = totals(state);
  const idle = IDLE_CLASSES.reduce((s, k) => s + (byClass[k] || 0), 0);
  const ratio = total > 0 ? idle / total : 0;
  const max = Number(state.settings.targets.idleCashRatioMax) || 0.25;
  const excess = Math.max(0, idle - total * max);
  return { idle, ratio, max, excess, total };
}

export function monthlyRecurringInvest(state) {
  return state.holdings.reduce((s, h) => s + (Number(h.recurring?.amountJpy) || 0), 0);
}

// 投資可能余力 = 収入 − 生活費 − ローン − 積立（設計書 §1.5）
export function investableCapacity(state) {
  const cf = state.cashflowProfile || {};
  return (
    (Number(cf.monthlyIncome) || 0) -
    (Number(cf.monthlyLiving) || 0) -
    (Number(cf.monthlyMortgage) || 0) -
    monthlyRecurringInvest(state)
  );
}

export function makeSnapshot(state) {
  const { total, byClass, byTheme } = totals(state);
  const roundMap = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)]));
  return newEntity({
    date: todayStr(),
    totalJpy: Math.round(total),
    byClass: roundMap(byClass),
    byTheme: roundMap(byTheme),
    fxUsdJpy: fxRate(state) || 0,
    auto: true,
  });
}

// 前月以前で最も新しいスナップショット（前月比の基準）
export function prevMonthSnapshot(state) {
  const ym = todayStr().slice(0, 7);
  const prior = state.snapshots
    .filter((s) => (s.date || '').slice(0, 7) < ym)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return prior[0] || null;
}

export function priceAgeDays(h) {
  const asOf = h.price?.asOf;
  if (!asOf) return null;
  const ms = Date.now() - new Date(asOf + 'T00:00:00').getTime();
  return Math.floor(ms / 86400000);
}

// 価格鮮度: asOf が90日超で警告（設計書 §2.3）
export function isPriceStale(h) {
  if (h.assetClass === 'cash') return false;
  const age = priceAgeDays(h);
  return age === null || age > 90;
}

export function themeById(state, id) {
  return state.themes.find((t) => t.id === id) || null;
}

export function accountById(state, id) {
  return state.accounts.find((a) => a.id === id) || null;
}

export function themeExposure(state, themeId) {
  const { byTheme } = totals(state);
  return byTheme[themeId] || 0;
}

export function intelForTheme(state, themeId) {
  return state.intel
    .filter((c) => (c.themeIds || []).includes(themeId))
    .sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
}

export function untriagedIntel(state) {
  return state.intel.filter((c) => !c.archived && (c.themeIds || []).length === 0);
}

export const DECISION_ACTIONS = {
  buy: '買い', sell: '売り', trim: '一部売却', add: '買い増し', pass: '見送り', rebalance: 'リバランス',
};

// ウォッチ銘柄の判定用価格: lastPrice（API/手動）が無ければ同一ティッカーの保有価格を流用
export function effectiveWatchPrice(state, w) {
  if (w.lastPrice && Number(w.lastPrice.value) > 0) return w.lastPrice;
  if (!w.ticker) return null;
  const h = state.holdings.find(
    (x) => x.ticker && x.ticker.toUpperCase() === w.ticker.toUpperCase() && Number(x.price?.value) > 0
  );
  return h ? h.price : null;
}

// 価格トリガーの自動判定（Phase 2）。価格更新のたびに呼ぶ。
// 成立 → firedAt を記録（確認済みは ackAt）。条件が外れたら両方クリア（再成立で再表示）。
export function evaluateTriggers(state) {
  let newlyFired = 0;
  for (const w of state.watchlist) {
    const p = effectiveWatchPrice(state, w);
    for (const tr of w.triggers || []) {
      if (tr.type !== 'price_below' && tr.type !== 'price_above') continue;
      const threshold = Number(tr.value);
      if (!p || !isFinite(threshold)) continue; // 価格不明なら状態を維持
      const hit = tr.type === 'price_below'
        ? Number(p.value) <= threshold
        : Number(p.value) >= threshold;
      if (hit) {
        if (!tr.firedAt) {
          tr.firedAt = todayStr();
          tr.ackAt = null;
          newlyFired++;
        }
      } else {
        tr.firedAt = null;
        tr.ackAt = null;
      }
    }
  }
  return newlyFired;
}

// レビュー期限が到来し、まだ結果を記録していない Decision
export function decisionsDueForReview(state) {
  const today = todayStr();
  return state.decisions.filter(
    (d) => d.review?.dueDate && d.review.dueDate <= today && !d.review.outcome
  );
}

// 放置検知: active テーマでインテル紐付けが約3か月途絶えているもの（設計書 §3.5）
export function neglectedThemes(state) {
  const NEGLECT_MS = 92 * 86400000;
  const result = [];
  for (const t of state.themes) {
    if (t.status !== 'active') continue;
    const dates = state.intel
      .filter((c) => (c.themeIds || []).includes(t.id))
      .map((c) => c.date)
      .filter(Boolean)
      .sort();
    const last = dates[dates.length - 1] || (t.createdAt || '').slice(0, 10);
    if (!last) continue;
    if (Date.now() - new Date(last + 'T00:00:00').getTime() > NEGLECT_MS) {
      result.push({ theme: t, lastIntelDate: dates.length ? last : null });
    }
  }
  return result;
}

// ---- Phase 4: マルチモデル選定エンジン（設計書 §5.2） ----
// 計算方針: weight 加重の単純リターン。配当・税・手数料は無視（厳密性より継続性）。
// リターンは同一通貨の価格比なので円換算は不要。

export const BENCHMARKS = { SPY: 'S&P500（SPY）', '1306': 'TOPIX（1306）' };

export function isJpTicker(ticker) {
  const t = String(ticker || '').toUpperCase();
  return /^\d{4}$/.test(t) || t.endsWith('.T');
}

// 日本株（4桁 or .T）→ 1306、それ以外 → SPY
export function pickBenchmarkKey(ticker) {
  return isJpTicker(ticker) ? '1306' : 'SPY';
}

export function recordBenchmark(state, key, value, date) {
  if (!(Number(value) > 0)) return;
  const arr = state.benchmarks[key] || (state.benchmarks[key] = []);
  const existing = arr.find((e) => e.date === date);
  if (existing) {
    existing.value = Number(value);
  } else {
    arr.push({ date, value: Number(value) });
    arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  if (arr.length > 500) arr.splice(0, arr.length - 500);
}

// 指定日以前の直近記録。無ければ猶予日数以内の直後の記録で代替、それも無ければ null（欠損）
export function benchmarkValueAt(state, key, date, graceDays = 7) {
  const arr = state.benchmarks?.[key] || [];
  let best = null;
  for (const e of arr) {
    if (e.date <= date) best = e;
    else break;
  }
  if (best) return best;
  const after = arr.find((e) => e.date > date);
  if (after && graceDays > 0) {
    const gap = (new Date(after.date) - new Date(date)) / 86400000;
    if (gap <= graceDays) return after;
  }
  return null;
}

export function benchmarkLatest(state, key) {
  const arr = state.benchmarks?.[key] || [];
  return arr[arr.length - 1] || null;
}

// ピックの現在価格: 自身の lastPrice → 同一ティッカーの保有価格 → ウォッチの lastPrice
export function effectivePickPrice(state, pick) {
  if (pick.lastPrice && Number(pick.lastPrice.value) > 0) return pick.lastPrice;
  const tk = String(pick.ticker || '').toUpperCase();
  if (!tk) return null;
  const h = state.holdings.find((x) => x.ticker && x.ticker.toUpperCase() === tk && Number(x.price?.value) > 0);
  if (h) return h.price;
  const w = state.watchlist.find((x) => (x.ticker || '').toUpperCase() === tk && Number(x.lastPrice?.value) > 0);
  if (w) return w.lastPrice;
  return null;
}

// ピック単体の成績。ベンチマーク欠損時は relReturn: null（計算を破綻させない）
export function pickPerformance(state, pick) {
  const entry = Number(pick.entryPrice);
  if (!(entry > 0)) return { status: 'no_entry' };
  const closed = !!pick.exitDate;
  const current = closed ? Number(pick.exitPrice) : Number(effectivePickPrice(state, pick)?.value);
  if (!(current > 0)) return { status: 'no_price' };
  const absReturn = current / entry - 1;
  const benchKey = pickBenchmarkKey(pick.ticker);
  const bEntry = benchmarkValueAt(state, benchKey, pick.date || '');
  const bNow = closed
    ? benchmarkValueAt(state, benchKey, pick.exitDate) || benchmarkLatest(state, benchKey)
    : benchmarkLatest(state, benchKey);
  const relReturn = bEntry && bNow && bEntry.value > 0 && bNow.date >= bEntry.date
    ? absReturn - (bNow.value / bEntry.value - 1)
    : null;
  return { status: 'ok', absReturn, relReturn, benchKey, closed, current };
}

export function modelPicksFor(state, modelId) {
  return state.modelPicks
    .filter((p) => p.modelId === modelId)
    .sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
}

// モデル別スコア: weight 加重の累積相対リターン・ヒット率・件数・稼働期間
export function modelStats(state, model) {
  const picks = modelPicksFor(state, model.id);
  let wSum = 0;
  let wRel = 0;
  let hit = 0;
  let covered = 0;
  let excluded = 0;
  for (const p of picks) {
    const perf = pickPerformance(state, p);
    if (perf.status !== 'ok' || perf.relReturn === null) {
      excluded++;
      continue;
    }
    const w = Number(p.weight) > 0 ? Number(p.weight) : 1;
    wSum += w;
    wRel += w * perf.relReturn;
    covered++;
    if (perf.relReturn > 0) hit++;
  }
  const dates = picks.map((p) => p.date).filter(Boolean).sort();
  return {
    pickCount: picks.length,
    relReturn: wSum > 0 ? wRel / wSum : null,
    hitRate: covered > 0 ? hit / covered : null,
    covered,
    excluded,
    since: dates[0] || null,
    until: model.status === 'retired' && model.retiredAt ? model.retiredAt.slice(0, 10) : todayStr(),
  };
}

// 参考シグナル: 当該銘柄をオープンなピックに含む active モデル（推奨ではなく一視点として表示）
export function modelsForTicker(state, ticker) {
  const tk = String(ticker || '').toUpperCase();
  if (!tk) return [];
  return state.models.filter(
    (m) => m.status === 'active' &&
      state.modelPicks.some((p) => p.modelId === m.id && !p.exitDate && String(p.ticker || '').toUpperCase() === tk)
  );
}

// 月次実行期日: 当月のピックが無い active モデル
export function modelsDueThisMonth(state) {
  const ym = todayStr().slice(0, 7);
  return state.models.filter(
    (m) => m.status === 'active' &&
      !state.modelPicks.some((p) => p.modelId === m.id && (p.date || '').startsWith(ym))
  );
}

// 手動エクスポートと自動バックアップのうち新しい方（設計書 §2.3 の30日警告はどちらの成立でも解消される）
export function latestBackupAt(state) {
  const a = state.settings.lastExportAt;
  const b = state.settings.lastAutoBackupAt;
  if (a && b) return a > b ? a : b;
  return a || b || null;
}

export function findRestricted(state, ticker) {
  if (!ticker) return null;
  const t = String(ticker).trim().toUpperCase();
  if (!t) return null;
  return state.restricted.find((r) => String(r.ticker || '').trim().toUpperCase() === t) || null;
}

// ダッシュボード「要アクション」（設計書 §2.2-4）
export function buildActions(state) {
  const actions = [];
  const hasData = state.holdings.length + state.themes.length + state.intel.length > 0;

  // 30日未バックアップ警告（設計書 §2.3。Phase 3: 手動エクスポートと自動バックアップの新しい方を採用）
  const last = latestBackupAt(state);
  if (hasData) {
    if (!last) {
      actions.push({ kind: 'warn', view: 'settings', label: 'バックアップ未実施 — JSON エクスポートを推奨（サイトデータ削除で全消失します）' });
    } else {
      const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
      if (days > 30) {
        actions.push({ kind: 'warn', view: 'settings', label: `最終バックアップから ${days} 日経過 — エクスポートを推奨` });
      }
    }
  }

  // 価格トリガー成立（Phase 2: 自動判定。確認済みで消し込み、再成立で再表示）
  for (const w of state.watchlist) {
    (w.triggers || []).forEach((tr, i) => {
      if (!tr.firedAt || tr.ackAt) return;
      const p = effectiveWatchPrice(state, w);
      const dir = tr.type === 'price_below' ? '下回りました' : '上回りました';
      actions.push({
        kind: 'warn',
        view: 'themes',
        type: 'trigger',
        watchId: w.id,
        triggerIndex: i,
        label: `トリガー成立: ${w.ticker} が ${tr.value} を${dir}（現在 ${p ? p.value : '-'}）${tr.note ? ' — ' + tr.note : ''}`,
      });
    });
  }

  // 判断レビュー期限（Phase 2）
  for (const d of decisionsDueForReview(state)) {
    actions.push({
      kind: 'warn',
      view: 'journal',
      label: `判断レビュー期限: ${d.date} ${DECISION_ACTIONS[d.action] || d.action} ${d.ticker || ''} — 判断の質と結果を分けて振り返る`,
    });
  }

  // モデル実行期日（Phase 4: 月次。当月ピック未記録の active モデル）
  const dueModels = modelsDueThisMonth(state);
  if (dueModels.length > 0) {
    actions.push({
      kind: 'info',
      view: 'models',
      label: `モデル実行（月次）: 今月のピック未記録 — ${dueModels.map((m) => m.name).join('、')}`,
    });
  }

  // 放置検知（Phase 2）
  for (const n of neglectedThemes(state)) {
    actions.push({
      kind: 'warn',
      view: 'themes',
      label: `放置検知: テーマ「${n.theme.name}」のインテルが3か月以上途絶えています${n.lastIntelDate ? `（最終 ${n.lastIntelDate}）` : '（紐付けなし）'}`,
    });
  }

  for (const c of state.intel) {
    if (c.actionNeeded && !c.archived) {
      actions.push({ kind: 'warn', view: 'intel', label: `要対応インテル: ${c.title || c.implication || c.rawNote || '(無題)'}`.slice(0, 60) });
    }
  }

  const untriaged = untriagedIntel(state).length;
  if (untriaged > 0) {
    actions.push({ kind: 'info', view: 'intel', label: `未トリアージのインテルが ${untriaged} 件` });
  }

  const stale = state.holdings.filter((h) => isPriceStale(h));
  if (stale.length > 0) {
    actions.push({ kind: 'info', view: 'portfolio', label: `価格が90日超未更新の保有が ${stale.length} 件` });
  }

  const { byTheme } = totals(state);
  for (const t of state.themes) {
    if (t.status === 'active' && !(byTheme[t.id] > 0)) {
      actions.push({ kind: 'info', view: 'themes', label: `テーマ「${t.name}」は仮説あり・エクスポージャーゼロ` });
    }
  }

  // 価格系は自動判定に移行済み（Phase 2）。イベント系のみ手動確認を促す
  const eventTriggers = state.watchlist.filter(
    (w) => w.status === 'watching' && (w.triggers || []).some((tr) => tr.type === 'event')
  );
  if (eventTriggers.length > 0) {
    actions.push({ kind: 'info', view: 'themes', label: `イベント型トリガーが ${eventTriggers.length} 銘柄にあり — 週次で成立を確認` });
  }

  return actions;
}
