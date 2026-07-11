// コンテキストパック生成（設計書 §3.3・付録B）+ テーマレビュー（§3.4-3）
// デフォルトでは資産の絶対額を AI に渡さない（比率のみ）。設定で切替可能。
import { ASSET_CLASSES, totals, holdingValueJpy, untriagedIntel, intelForTheme } from './derive.js';
import { todayStr } from './state.js';

const TRIGGER_LABEL = { price_below: '株価が下回ったら', price_above: '株価が上回ったら', event: 'イベント' };

// 付録C: 貼り戻し JSON フェンス規約（AI に出力させるフォーマット）
const OUTPUT_FORMAT = [
  '```json',
  '{',
  '  "briefing": {',
  `    "date": "${todayStr()}",`,
  '    "cards": [',
  '      { "title": "", "sourceUrl": "", "summary": "", "implication": "",',
  '        "sentiment": "positive|negative|neutral",',
  '        "themes": ["テーマ名で指定"],',
  '        "tickers": [], "actionNeeded": false }',
  '    ],',
  '    "themeAssessments": [',
  '      { "theme": "", "verdict": "progress|setback|neutral", "reason": "" }',
  '    ],',
  '    "blindSpot": ""',
  '  }',
  '}',
  '```',
].join('\n');

export function buildContextPack(state) {
  const abs = !!state.settings.ai.includeAbsoluteAmounts;
  const { total, byClass } = totals(state);
  const L = [];

  L.push('あなたは私専属の投資参謀です。売買の断定的推奨はせず、情報整理と示唆の提示に徹してください。');
  L.push('');
  L.push('# 私のプロフィール');
  L.push(state.settings.ai.profile || '（未設定）');

  L.push('');
  L.push('# 現在のテーマと仮説');
  const themes = state.themes.filter((t) => t.status !== 'closed');
  if (themes.length === 0) L.push('（テーマ未登録）');
  for (const t of themes) {
    L.push(`- ${t.name}（確信度 ${t.conviction ?? '-'} /5、期間 ${t.horizon || '-'}、状態 ${t.status}）`);
    if (t.thesis) L.push(`  仮説: ${t.thesis}`);
    if (t.kpis && t.kpis.length) L.push(`  KPI: ${t.kpis.join(' / ')}`);
  }

  L.push('');
  L.push(`# ポートフォリオ概況（${abs ? '金額あり' : '比率のみ'}）`);
  if (total <= 0) {
    L.push('（保有データなし）');
  } else {
    if (abs) L.push(`- 総資産: 約¥${Math.round(total).toLocaleString('ja-JP')}`);
    for (const [k, label] of Object.entries(ASSET_CLASSES)) {
      const v = byClass[k] || 0;
      if (v <= 0) continue;
      const pct = ((v / total) * 100).toFixed(1);
      L.push(`- ${label}: ${pct}%${abs ? `（約¥${Math.round(v).toLocaleString('ja-JP')}）` : ''}`);
    }
    const named = state.holdings
      .filter((h) => h.ticker)
      .map((h) => ({ t: h.ticker, v: holdingValueJpy(h, state) }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 8);
    if (named.length) {
      L.push('- 主要銘柄: ' + named.map((x) => `${x.t} ${((x.v / total) * 100).toFixed(1)}%`).join(', '));
    }
  }

  L.push('');
  L.push('# ウォッチリスト');
  const watching = state.watchlist.filter((w) => w.status !== 'passed');
  if (watching.length === 0) L.push('（なし）');
  for (const w of watching) {
    const trg = (w.triggers || [])
      .map((t) => `${TRIGGER_LABEL[t.type] || t.type}: ${t.value}${t.note ? `（${t.note}）` : ''}`)
      .join('; ');
    L.push(`- ${w.ticker}（${w.name || '-'}）: ${w.whyWatch || '-'}${trg ? ` / トリガー: ${trg}` : ''}`);
  }

  L.push('');
  L.push('# 今週のインプット（未処理）');
  const inbox = untriagedIntel(state);
  if (inbox.length === 0) L.push('（なし）');
  for (const c of inbox) {
    if (c.sourceType === 'url') {
      L.push(`- [URL] ${c.title || '(タイトル未設定)'} — ${c.sourceUrl || ''}`);
    } else {
      const tag = c.sourceType === 'work_insight' ? '業務知見メモ' : 'メモ';
      L.push(`- [${tag}] ${(c.rawNote || c.title || '').slice(0, 300)}`);
    }
  }

  L.push('');
  L.push('# 依頼');
  L.push('1. 各インプットを要約し、私のテーマ・保有・ウォッチへの含意（so-what）を付す');
  L.push('2. テーマごとに今週の評価（進展/後退/中立）と理由');
  L.push('3. 私が見落としていそうな論点があれば1つだけ指摘');
  L.push('4. 出力は必ず下記フォーマットで（回答末尾に JSON コードフェンスを1つだけ出力）');

  L.push('');
  L.push('# 制約');
  L.push('- 未公開情報・非公開の業務情報を根拠にしない。公開情報で裏取り可能な内容のみ');
  L.push('- 不確実な点は不確実と明記する');

  L.push('');
  L.push('# 出力フォーマット（回答の末尾に必ずこの形式の JSON ブロックを出力）');
  L.push(OUTPUT_FORMAT);

  return L.join('\n');
}

// テーマレビュー（四半期）の出力フォーマット（付録Cの Phase 2 拡張）
const THEME_REVIEW_FORMAT = [
  '```json',
  '{',
  '  "themeReview": {',
  '    "theme": "テーマ名（そのまま返す）",',
  `    "date": "${todayStr()}",`,
  '    "summary": "総括（2-3文）",',
  '    "counterEvidence": ["thesis への反証材料（公開情報で確認できるもの）"],',
  '    "kpiStatus": [',
  '      { "kpi": "", "status": "progress|setback|neutral", "note": "" }',
  '    ],',
  '    "exposureView": "エクスポージャーの過不足に関する複数の見方（断定しない）",',
  '    "nextChecks": ["次の四半期に確認すべきチェックポイント"]',
  '  }',
  '}',
  '```',
].join('\n');

// モデル実行（月次）の出力フォーマット（付録Cの Phase 4 拡張）
function modelPicksFormat(modelName) {
  return [
    '```json',
    '{',
    '  "modelPicks": {',
    `    "model": "${modelName}",`,
    `    "date": "${todayStr()}",`,
    '    "picks": [',
    '      { "ticker": "VRT", "weight": 0.5, "rationale": "選定理由（公開情報の根拠）" }',
    '    ]',
    '  }',
    '}',
    '```',
  ].join('\n');
}

// モデル実行プロンプト（設計書 §5.2。logicPrompt + コンテキストの合成）
export function buildModelRunPrompt(state, model) {
  const abs = !!state.settings.ai.includeAbsoluteAmounts;
  const { total, byClass } = totals(state);
  const L = [];

  L.push('あなたは私専属の投資参謀です。売買の断定的推奨はせず、情報整理と示唆の提示に徹してください。');
  L.push('これは月次のモデル実行です。下記の「選定ロジック」に忠実に従い、仮想ポートフォリオのピックを出してください。');
  L.push('ピックは選別実験のための参考シグナルであり、推奨ではありません。');

  L.push('');
  L.push(`# 選定ロジック（モデル: ${model.name}）`);
  L.push(model.logicPrompt || '（未設定）');

  L.push('');
  L.push('# 私のプロフィール');
  L.push(state.settings.ai.profile || '（未設定）');

  L.push('');
  L.push('# 現在のテーマと仮説');
  const themes = state.themes.filter((t) => t.status !== 'closed');
  if (themes.length === 0) L.push('（テーマ未登録）');
  for (const t of themes) {
    L.push(`- ${t.name}（確信度 ${t.conviction ?? '-'} /5、期間 ${t.horizon || '-'}、状態 ${t.status}）`);
    if (t.thesis) L.push(`  仮説: ${t.thesis}`);
    if (t.kpis && t.kpis.length) L.push(`  KPI: ${t.kpis.join(' / ')}`);
  }

  L.push('');
  L.push(`# ポートフォリオ概況（${abs ? '金額あり' : '比率のみ'}）`);
  if (total <= 0) {
    L.push('（保有データなし）');
  } else {
    for (const [k, label] of Object.entries(ASSET_CLASSES)) {
      const v = byClass[k] || 0;
      if (v <= 0) continue;
      L.push(`- ${label}: ${((v / total) * 100).toFixed(1)}%${abs ? `（約¥${Math.round(v).toLocaleString('ja-JP')}）` : ''}`);
    }
  }

  L.push('');
  L.push('# ウォッチリスト');
  const watching = state.watchlist.filter((w) => w.status !== 'passed');
  if (watching.length === 0) L.push('（なし）');
  for (const w of watching) {
    L.push(`- ${w.ticker}（${w.name || '-'}）: ${w.whyWatch || '-'}`);
  }

  L.push('');
  L.push('# このモデルの直近ピック（重複を避ける参考）');
  const recent = state.modelPicks
    .filter((p) => p.modelId === model.id)
    .sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1))
    .slice(0, 10);
  if (recent.length === 0) L.push('（なし — 初回実行）');
  for (const p of recent) {
    L.push(`- ${p.date} ${p.ticker}（weight ${p.weight}${p.exitDate ? `、${p.exitDate} クローズ` : ''}）`);
  }

  L.push('');
  L.push('# 依頼');
  L.push('1. 上記の選定ロジックを適用し、ピックを最大5件、weight（合計 1.0）付きで出す');
  L.push('2. 各ピックに、公開情報で裏取り可能な根拠を付す');
  L.push('3. ロジックに合致する銘柄が無ければ、無理に選ばず picks を空配列にしてよい');
  L.push('4. 出力は必ず下記フォーマットで（回答末尾に JSON コードフェンスを1つだけ出力。model 名は変えずにそのまま返す）');

  L.push('');
  L.push('# 制約');
  L.push('- 未公開情報・非公開の業務情報を根拠にしない。公開情報で裏取り可能な内容のみ');
  L.push('- 不確実な点は不確実と明記する');

  L.push('');
  L.push('# 出力フォーマット（回答の末尾に必ずこの形式の JSON ブロックを出力）');
  L.push(modelPicksFormat(model.name));

  return L.join('\n');
}

// テーマレビュー（四半期）プロンプト（設計書 §3.4-3）
export function buildThemeReviewPrompt(state, theme) {
  const abs = !!state.settings.ai.includeAbsoluteAmounts;
  const { total, byTheme } = totals(state);
  const exposure = byTheme[theme.id] || 0;
  const pct = total > 0 ? ((exposure / total) * 100).toFixed(1) : '0.0';
  const holdings = state.holdings.filter((h) => (h.themeIds || []).includes(theme.id));
  const watch = state.watchlist.filter((w) => (w.themeIds || []).includes(theme.id));
  const intel = intelForTheme(state, theme.id).slice(0, 10);
  const L = [];

  L.push('あなたは私専属の投資参謀です。売買の断定的推奨はせず、情報整理と示唆の提示に徹してください。');
  L.push('これは四半期に一度のテーマレビューです。仮説に都合の良い情報だけでなく、反証材料を重視してください。');
  L.push('');
  L.push('# 私のプロフィール');
  L.push(state.settings.ai.profile || '（未設定）');

  L.push('');
  L.push('# レビュー対象テーマ');
  L.push(`- テーマ名: ${theme.name}`);
  L.push(`- 仮説（thesis）: ${theme.thesis || '未記入'}`);
  L.push(`- 自分の情報優位（myEdge）: ${theme.myEdge || '未記入'}`);
  L.push(`- 確信度: ${theme.conviction ?? '-'} /5 ／ 期間: ${theme.horizon || '-'} ／ 状態: ${theme.status}`);
  if ((theme.kpis || []).length) L.push(`- KPI: ${theme.kpis.join(' / ')}`);
  if (theme.reviewNote) L.push(`- 過去のレビューノート（抜粋）:\n${theme.reviewNote.split('\n').slice(0, 8).join('\n')}`);

  L.push('');
  L.push('# このテーマのエクスポージャー');
  L.push(`- 総資産に対する比率: ${pct}%${abs ? `（約¥${Math.round(exposure).toLocaleString('ja-JP')}）` : ''}`);
  L.push(holdings.length
    ? `- 保有: ${holdings.map((h) => h.ticker || h.name).join(', ')}`
    : '- 保有: なし（エクスポージャーゼロ）');
  if (watch.length) {
    L.push(`- ウォッチ: ${watch.map((w) => `${w.ticker}（${w.whyWatch || '-'}）`).join(' / ')}`);
  }

  L.push('');
  L.push('# このテーマの最近のインテル（直近10件）');
  if (intel.length === 0) L.push('（なし — 情報が途絶えています）');
  for (const c of intel) {
    L.push(`- [${c.date || '-'} / ${c.sentiment}] ${(c.implication || c.aiSummary || c.title || c.rawNote || '').slice(0, 150)}`);
  }

  L.push('');
  L.push('# 依頼（四半期テーマレビュー）');
  L.push('1. thesis への反証材料を最大3つ挙げる（公開情報で確認できるもののみ）');
  L.push('2. 各 KPI の最新状況を整理し、progress / setback / neutral で評価する');
  L.push('3. 現在のエクスポージャーの過不足について複数の見方を提示する（断定はしない）');
  L.push('4. 次の四半期に確認すべきチェックポイントを最大3つ提案する');
  L.push('5. 出力は必ず下記フォーマットで（回答末尾に JSON コードフェンスを1つだけ出力）');

  L.push('');
  L.push('# 制約');
  L.push('- 未公開情報・非公開の業務情報を根拠にしない。公開情報で裏取り可能な内容のみ');
  L.push('- 不確実な点は不確実と明記する');

  L.push('');
  L.push('# 出力フォーマット（回答の末尾に必ずこの形式の JSON ブロックを出力）');
  L.push(THEME_REVIEW_FORMAT);

  return L.join('\n');
}
