// エントリポイント: ルーティング・起動時処理（月次スナップショット / 為替取得 / トリガー評価 / Share Target）・SW 登録
import { state, save, todayStr } from './state.js';
import { makeSnapshot, evaluateTriggers } from './derive.js';
import { fetchFx } from './api.js';
import { toast } from './ui.js';
import * as dashboard from './views/dashboard.js';
import * as portfolio from './views/portfolio.js';
import * as themes from './views/themes.js';
import * as intel from './views/intel.js';
import * as journal from './views/journal.js';
import * as models from './views/models.js';
import * as settings from './views/settings.js';

const VIEWS = { dashboard, portfolio, themes, intel, journal, models, settings };

// 下部タブは設計書 §2.1 の5つ。設定はヘッダーの ⚙️ から
const TABS = [
  ['dashboard', '🏠', '司令部'],
  ['portfolio', '📊', '資産'],
  ['themes', '🧭', 'テーマ'],
  ['intel', '📥', 'インテル'],
  ['journal', '📓', 'ジャーナル'],
];

function currentView() {
  const v = location.hash.replace(/^#\/?/, '');
  return VIEWS[v] ? v : 'dashboard';
}

export function go(view) {
  if (currentView() === view) {
    render();
  } else {
    location.hash = '#/' + view;
  }
}

export function render() {
  const view = currentView();
  VIEWS[view].render(document.getElementById('view'));
  document.querySelectorAll('#tabbar .tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === view);
  });
  window.scrollTo(0, 0);
}

function renderTabs() {
  const nav = document.getElementById('tabbar');
  nav.innerHTML = TABS.map(([v, icon, label]) => `
    <button class="tab" data-view="${v}">
      <span class="tab-icon">${icon}</span>
      <span class="tab-label">${label}</span>
    </button>`).join('');
  nav.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => go(b.dataset.view));
  });
  const gear = document.getElementById('btn-settings');
  if (gear) gear.addEventListener('click', () => go('settings'));
  const modelsBtn = document.getElementById('btn-models');
  if (modelsBtn) modelsBtn.addEventListener('click', () => go('models'));
}

// PWA Share Target（GET）: 共有メニューから渡された title/text/url を
// 未トリアージの IntelCard として保存する（設計書 §3.2。Phase 2）
function handleShareTarget() {
  const q = new URLSearchParams(location.search);
  if (!q.has('url') && !q.has('text') && !q.has('title')) return;
  const title = (q.get('title') || '').trim();
  const text = (q.get('text') || '').trim();
  let url = (q.get('url') || '').trim();
  if (!url) {
    const m = text.match(/https?:\/\/[^\s]+/); // Android は URL を text に載せることが多い
    if (m) url = m[0];
  }
  history.replaceState(null, '', location.pathname); // 再読み込みでの二重登録を防ぐ
  if (!title && !text && !url) return;
  state.intel.push(intel.newIntelCard({
    sourceType: url ? 'url' : 'memo',
    sourceUrl: url,
    title,
    rawNote: text && text !== url ? text : '',
  }));
  save();
  location.hash = '#/intel';
  setTimeout(() => toast('共有された内容を受信箱に追加しました'), 500);
}

// 起動時: 当月スナップショットが無ければ現在値で自動記録（設計書 §1.4）
function ensureMonthlySnapshot() {
  if (state.holdings.length === 0) return; // データ投入前のゼロ記録は避ける
  const ym = todayStr().slice(0, 7);
  if (state.snapshots.some((s) => (s.date || '').startsWith(ym))) return;
  state.snapshots.push(makeSnapshot(state));
  save();
  setTimeout(() => toast('当月のスナップショットを自動記録しました'), 800);
}

// 起動時: 為替を裏で更新（失敗しても前回値のまま。機能は止めない）
async function refreshFxInBackground() {
  if (!navigator.onLine) return;
  const r = await fetchFx(state);
  if (r.ok) {
    save();
    render();
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!['https:', 'http:'].includes(location.protocol)) return;
  navigator.serviceWorker.register('./sw.js').catch((e) => {
    console.warn('Service Worker の登録に失敗しました', e);
  });
}

window.addEventListener('hashchange', render);

renderTabs();
ensureMonthlySnapshot();
handleShareTarget();
// 起動時にもトリガーを評価（閾値の編集やインポート直後の状態を反映）
if (evaluateTriggers(state) > 0) {
  setTimeout(() => toast('価格トリガーが成立しています（司令部の要アクション参照）'), 1200);
}
save();
render();
refreshFxInBackground();
registerServiceWorker();
