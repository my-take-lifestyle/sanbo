// AI 回答の貼り戻しパース（設計書 §3.3・付録C + Phase 2/4 拡張）
// JSON フェンス規約のブロックのみをパースし、失敗時はデータを失わず生テキストで保存する。
import { newEntity, todayStr } from './state.js';
import { effectivePickPrice } from './derive.js';

// テキストから貼り戻しブロックを抽出。付録C（briefing）と Phase 2 拡張（themeReview）に対応。
// 戻り値: { type: 'briefing' | 'themeReview', data } または null。
export function extractPasteback(text) {
  if (!text || !text.trim()) return null;
  const candidates = [];
  // ```json フェンス（後方のものを優先）
  for (const m of text.matchAll(/```json\s*([\s\S]*?)```/gi)) candidates.push(m[1]);
  // 言語指定なしフェンス
  for (const m of text.matchAll(/```\s*\n([\s\S]*?)```/g)) candidates.push(m[1]);
  // フェンスなしで全文が JSON の場合
  candidates.push(text);
  // 最初の { から最後の } まで
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates.reverse()) {
    try {
      const obj = JSON.parse(c.trim());
      const briefing = obj?.briefing || (Array.isArray(obj?.cards) ? obj : null);
      if (briefing && Array.isArray(briefing.cards)) return { type: 'briefing', data: briefing };
      if (obj?.themeReview && obj.themeReview.theme) return { type: 'themeReview', data: obj.themeReview };
      if (obj?.modelPicks && Array.isArray(obj.modelPicks.picks)) return { type: 'modelPicks', data: obj.modelPicks };
    } catch (e) {
      /* 次の候補へ */
    }
  }
  return null;
}

function resolveThemeIds(state, names) {
  const ids = [];
  for (const name of names || []) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) continue;
    const hit = state.themes.find((t) => {
      const tn = (t.name || '').toLowerCase();
      return tn === n || tn.includes(n) || n.includes(tn);
    });
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

function resolveTickers(state, tickers) {
  const watchIds = [];
  const holdingIds = [];
  for (const raw of tickers || []) {
    const tk = String(raw || '').trim().toUpperCase();
    if (!tk) continue;
    const w = state.watchlist.find((x) => (x.ticker || '').toUpperCase() === tk);
    if (w && !watchIds.includes(w.id)) watchIds.push(w.id);
    const h = state.holdings.find((x) => (x.ticker || '').toUpperCase() === tk);
    if (h && !holdingIds.includes(h.id)) holdingIds.push(h.id);
  }
  return { watchIds, holdingIds };
}

const SENTIMENTS = ['positive', 'negative', 'neutral'];

// パース成功時: IntelCard 群 + テーマ別示唆 + 見落とし指摘に展開して state へ反映
export function applyBriefing(state, briefing) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(briefing.date || '') ? briefing.date : todayStr();
  let cardCount = 0;
  let assessCount = 0;

  for (const c of briefing.cards || []) {
    const themeIds = resolveThemeIds(state, c.themes);
    const { watchIds, holdingIds } = resolveTickers(state, c.tickers);
    state.intel.push(
      newEntity({
        date,
        sourceType: 'ai_briefing',
        sourceUrl: c.sourceUrl || '',
        title: c.title || '',
        rawNote: '',
        aiSummary: c.summary || '',
        implication: c.implication || '',
        sentiment: SENTIMENTS.includes(c.sentiment) ? c.sentiment : 'neutral',
        themeIds,
        watchIds,
        holdingIds,
        actionNeeded: !!c.actionNeeded,
        actionNote: '',
        archived: false,
      })
    );
    cardCount++;
  }

  const VERDICT_LABEL = { progress: '進展', setback: '後退', neutral: '中立' };
  for (const a of briefing.themeAssessments || []) {
    const ids = resolveThemeIds(state, [a.theme]);
    if (ids.length === 0) continue;
    const theme = state.themes.find((t) => t.id === ids[0]);
    const line = `[${date} AI評価] ${VERDICT_LABEL[a.verdict] || a.verdict || '-'}: ${a.reason || ''}`;
    theme.reviewNote = line + (theme.reviewNote ? '\n' + theme.reviewNote : '');
    theme.updatedAt = new Date().toISOString();
    assessCount++;
  }

  let blindSpot = false;
  if (briefing.blindSpot && String(briefing.blindSpot).trim()) {
    state.intel.push(
      newEntity({
        date,
        sourceType: 'ai_briefing',
        sourceUrl: '',
        title: '見落としの指摘（AI）',
        rawNote: '',
        aiSummary: '',
        implication: String(briefing.blindSpot),
        sentiment: 'neutral',
        themeIds: [],
        watchIds: [],
        holdingIds: [],
        actionNeeded: true,
        actionNote: '',
        archived: false,
      })
    );
    blindSpot = true;
  }

  return { cardCount, assessCount, blindSpot };
}

const KPI_VERDICT_LABEL = { progress: '進展', setback: '後退', neutral: '中立' };

// テーマレビュー（Phase 2 拡張）の取り込み: reviewNote へ追記 + IntelCard 1枚を生成
// テーマ名を解決できなければ null を返す（呼び出し側で生テキスト保存にフォールバック）
export function applyThemeReview(state, tr) {
  const ids = resolveThemeIds(state, [tr.theme]);
  if (ids.length === 0) return null;
  const theme = state.themes.find((t) => t.id === ids[0]);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(tr.date || '') ? tr.date : todayStr();

  const lines = [];
  if (tr.summary) lines.push(`総括: ${tr.summary}`);
  for (const ce of tr.counterEvidence || []) lines.push(`反証: ${ce}`);
  for (const k of tr.kpiStatus || []) {
    lines.push(`KPI「${k.kpi || '-'}」: ${KPI_VERDICT_LABEL[k.status] || k.status || '-'}${k.note ? ` — ${k.note}` : ''}`);
  }
  if (tr.exposureView) lines.push(`エクスポージャー: ${tr.exposureView}`);
  for (const c of tr.nextChecks || []) lines.push(`次回チェック: ${c}`);

  const block = `[${date} テーマレビューAI]` + (lines.length ? '\n' + lines.join('\n') : '');
  theme.reviewNote = block + (theme.reviewNote ? '\n' + theme.reviewNote : '');
  theme.updatedAt = new Date().toISOString();

  state.intel.push(
    newEntity({
      date,
      sourceType: 'ai_briefing',
      sourceUrl: '',
      title: `テーマレビュー（AI）: ${theme.name}`,
      rawNote: '',
      aiSummary: lines.join('\n'),
      implication: tr.exposureView || tr.summary || '',
      sentiment: 'neutral',
      themeIds: [theme.id],
      watchIds: [],
      holdingIds: [],
      actionNeeded: false,
      actionNote: (tr.nextChecks || []).join(' / '),
      archived: false,
    })
  );

  return { themeName: theme.name, counterEvidence: (tr.counterEvidence || []).length };
}

// モデルピック（Phase 4）の取り込み: モデル名を解決し ModelPick 群を生成
// excludeTickers は制限リスト警告で除外が選ばれた銘柄（呼び出し側 UI が確認済み）
// エントリー価格は既知の価格（保有/ウォッチ）から同期解決。未解決は null（後から API/手動で補完）
export function applyModelPicks(state, data, excludeTickers = new Set()) {
  const name = String(data.model || '').trim().toLowerCase();
  if (!name) return null;
  const model = state.models.find((m) => {
    const n = (m.name || '').toLowerCase();
    return n === name || n.includes(name) || name.includes(n);
  });
  if (!model) return null;

  const date = /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : todayStr();
  const created = [];
  let skipped = 0;
  for (const p of data.picks || []) {
    const ticker = String(p.ticker || '').trim().toUpperCase();
    if (!ticker || excludeTickers.has(ticker)) {
      skipped++;
      continue;
    }
    const known = effectivePickPrice(state, { ticker, lastPrice: null });
    created.push(newEntity({
      modelId: model.id,
      date,
      ticker,
      entryPrice: known ? Number(known.value) : null,
      weight: Number(p.weight) > 0 ? Number(p.weight) : 1,
      rationale: String(p.rationale || ''),
      exitDate: null,
      exitPrice: null,
      lastPrice: null,
    }));
  }
  state.modelPicks.push(...created);
  return { model, created, skipped };
}

// パース失敗時: 全文を1枚の IntelCard として保存（壊れない）
export function saveRawFallback(state, text) {
  state.intel.push(
    newEntity({
      date: todayStr(),
      sourceType: 'ai_briefing',
      sourceUrl: '',
      title: '週次ブリーフィング貼り戻し（未パース）',
      rawNote: text,
      aiSummary: '',
      implication: '',
      sentiment: 'neutral',
      themeIds: [],
      watchIds: [],
      holdingIds: [],
      actionNeeded: false,
      actionNote: '',
      archived: false,
    })
  );
}
