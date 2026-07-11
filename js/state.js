// appState の永続化層（設計書 付録A）
// localStorage の単一 JSON。マイグレーションで後方互換を維持する。
import { ulid } from './ulid.js';

const KEY = 'sanbo.appState';
const PRE_IMPORT_BACKUP_KEY = 'sanbo.appState.preImportBackup';
export const SCHEMA_VERSION = 4;

const DEFAULT_PROFILE =
  '素材メーカー事業開発。専門: フィルム/多孔質材料/テープ、DC市場、半導体スタートアップM&A、グリーン水素電解、AI駆動素材探索。\n' +
  '投資スタイル: テーマ投資。判断は自分で行うため断定推奨は不要。';

export function nowIso() {
  return new Date().toISOString();
}

// 日付は JST（端末ローカル）の YYYY-MM-DD 固定（設計書 §4.3）
export function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// YYYY-MM-DD に n か月加算（月末は繰り上げず月内に丸める）
export function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastDay));
  const mm = String(target.getMonth() + 1).padStart(2, '0');
  const dd = String(target.getDate()).padStart(2, '0');
  return `${target.getFullYear()}-${mm}-${dd}`;
}

// 初期モデル3本（設計書 §5.2 初期モデル案。視点が直交する3本で開始する）
// テンプレとして同梱 — 内容は自由に編集・retire してよい
export function seedModels() {
  const t = nowIso();
  const base = { cadence: 'monthly', status: 'active', retiredAt: null, retiredReason: null, createdAt: t, updatedAt: t };
  const CONSTRAINT =
    '制約: 公開情報で裏取り可能な根拠のみを使う。未公開情報・非公開の業務情報は使わない。\n' +
    '断定的推奨はしない — これは複数ある仮説視点の一つであり、最終判断は私が行う。';
  return [
    {
      id: 'm_momentum',
      name: 'テーマ・モメンタム型',
      origin: '設計書 §5.2 初期モデル案①（KPI とニュースフローの加速度に着目）',
      logicPrompt:
        'あなたはテーマ・モメンタム型の選定モデルです。\n' +
        '私のテーマ一覧・KPI・直近のインテルから、KPI とニュースフローの改善が「加速」しているテーマ上位2つを特定し、' +
        'それぞれの代表銘柄を最大2つずつピックしてください。\n' +
        '各ピックには weight（全ピック合計で 1.0）と、加速を示す公開情報の根拠を付けること。\n' +
        CONSTRAINT,
      ...base,
    },
    {
      id: 'm_contrarian',
      name: 'コントラリアン型',
      origin: '設計書 §5.2 初期モデル案②（良テーマ内の悲観された銘柄）',
      logicPrompt:
        'あなたはコントラリアン型の選定モデルです。\n' +
        '私の active テーマのうち、テーマ自体の長期仮説は維持されているのに、直近3〜6か月で市場の悲観' +
        '（株価下落・ネガティブなニュースフロー）が強い銘柄を最大3つピックしてください。\n' +
        '各ピックには weight（合計 1.0）を付け、悲観が過剰だと考える根拠と、悲観が正しかった場合のリスクを併記すること。\n' +
        CONSTRAINT,
      ...base,
    },
    {
      id: 'm_quality',
      name: 'クオリティ・バリュエーション型',
      origin: '設計書 §5.2 初期モデル案③（テーマ内の財務健全 × 相対割安）',
      logicPrompt:
        'あなたはクオリティ・バリュエーション型の選定モデルです。\n' +
        '私のテーマに関連する銘柄のうち、財務健全性（利益率・負債水準・キャッシュフロー）が高く、' +
        '同業・同テーマ内で相対的に割安なものを最大3つピックしてください。\n' +
        '各ピックには weight（合計 1.0）を付け、使用した指標と比較対象を明記すること。\n' +
        CONSTRAINT,
      ...base,
    },
  ];
}

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: {
      baseCurrency: 'JPY',
      targets: { idleCashRatioMax: 0.25, emergencyMonths: 6 },
      api: { finnhubKey: null, twelveDataKey: null },
      ai: { includeAbsoluteAmounts: false, profile: DEFAULT_PROFILE },
      lastExportAt: null,
      lastAutoBackupAt: null,
      lastAutoBackupMethod: null, // 'file-system' | 'download'
    },
    fx: { USDJPY: null }, // { value, asOf, source }
    accounts: [],
    holdings: [],
    snapshots: [],
    cashflowProfile: {
      monthlyIncome: 0,
      monthlyLiving: 0,
      monthlyMortgage: 0,
      emergencyFundTargetJpy: 0,
    },
    themes: [],
    watchlist: [],
    intel: [],
    decisions: [],
    restricted: [],
    models: seedModels(),
    modelPicks: [],
    benchmarks: { SPY: [], '1306': [] }, // key → [{date, value}]（相対リターン計算用の価格系列）
  };
}

// 欠損キーを補完しつつ現行スキーマへ引き上げる
export function migrate(s) {
  const d = defaultState();
  if (!s || typeof s !== 'object') return d;
  const fromVersion = Number(s.schemaVersion) || 1;
  const out = { ...d, ...s };
  out.settings = { ...d.settings, ...(s.settings || {}) };
  out.settings.targets = { ...d.settings.targets, ...(s.settings?.targets || {}) };
  out.settings.api = { ...d.settings.api, ...(s.settings?.api || {}) };
  out.settings.ai = { ...d.settings.ai, ...(s.settings?.ai || {}) };
  out.fx = { ...d.fx, ...(s.fx || {}) };
  out.cashflowProfile = { ...d.cashflowProfile, ...(s.cashflowProfile || {}) };
  for (const k of ['accounts', 'holdings', 'snapshots', 'themes', 'watchlist', 'intel', 'decisions', 'restricted', 'models', 'modelPicks']) {
    if (!Array.isArray(out[k])) out[k] = [];
  }

  // v2（Phase 2）: フィールド補完。冪等なので毎回実行してよい
  for (const w of out.watchlist) {
    if (w.lastPrice === undefined) w.lastPrice = null;
    w.triggers = (w.triggers || []).map((tr) => ({ firedAt: null, ackAt: null, ...tr }));
  }
  for (const dc of out.decisions) {
    if (!Array.isArray(dc.intelIds)) dc.intelIds = [];
    dc.review = {
      dueDate: null,
      judgmentQuality: null,
      outcome: null,
      lesson: null,
      ...(dc.review || {}),
    };
  }

  // v3（Phase 3）: 自動バックアップの記録欄を補完
  if (out.settings.lastAutoBackupAt === undefined) out.settings.lastAutoBackupAt = null;
  if (out.settings.lastAutoBackupMethod === undefined) out.settings.lastAutoBackupMethod = null;

  // v4（Phase 4）: モデル/ピック/ベンチマークの補完
  out.benchmarks = { SPY: [], '1306': [], ...(s.benchmarks || {}) };
  for (const k of Object.keys(out.benchmarks)) {
    if (!Array.isArray(out.benchmarks[k])) out.benchmarks[k] = [];
  }
  for (const m of out.models) {
    if (!m.status) m.status = 'active';
    if (!m.cadence) m.cadence = 'monthly';
    if (m.retiredAt === undefined) m.retiredAt = null;
    if (m.retiredReason === undefined) m.retiredReason = null;
  }
  for (const p of out.modelPicks) {
    if (p.lastPrice === undefined) p.lastPrice = null;
    if (p.exitDate === undefined) p.exitDate = null;
    if (p.exitPrice === undefined) p.exitPrice = null;
    if (!(Number(p.weight) > 0)) p.weight = 1;
    if (p.rationale === undefined) p.rationale = '';
  }
  // v4 移行時にモデルが空なら初期モデル3本をテンプレ投入（v4 以降で全削除した場合は復活させない）
  if (fromVersion < 4 && out.models.length === 0) {
    out.models = seedModels();
  }

  out.schemaVersion = SCHEMA_VERSION;
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
  } catch (e) {
    console.error('appState の読み込みに失敗しました。初期状態で起動します。', e);
    return defaultState();
  }
}

export let state = load();

export function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

// インポート時: 現行データを退避してから差し替える（設計書 §4.4）
export function replaceState(next) {
  try {
    localStorage.setItem(PRE_IMPORT_BACKUP_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('退避バックアップの保存に失敗しました', e);
  }
  state = migrate(next);
  save();
}

export function clearAll() {
  localStorage.removeItem(KEY);
  state = defaultState();
}

export function newEntity(fields = {}) {
  const t = nowIso();
  return { id: ulid(), createdAt: t, updatedAt: t, ...fields };
}

export function touch(entity) {
  if (entity) entity.updatedAt = nowIso();
}
