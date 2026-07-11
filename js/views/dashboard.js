// ダッシュボード（司令部）— 読む場（設計書 §2.2）
import { state, save, todayStr, touch } from '../state.js';
import {
  totals, idleCash, prevMonthSnapshot, buildActions, fxRate,
  investableCapacity, ASSET_CLASSES, CHART_COLORS, holdingValueJpy,
} from '../derive.js';
import { esc, fmtJpy, fmtSignedJpy, fmtPct, sentimentDot, toast } from '../ui.js';
import { go } from '../app.js';

let allocMode = 'class'; // 'class' | 'theme'
let chart = null;

export function render(root) {
  const { total, byClass, byTheme } = totals(state);
  const idle = idleCash(state);
  const prev = prevMonthSnapshot(state);
  const fx = state.fx.USDJPY;
  const actions = buildActions(state);
  const capacity = investableCapacity(state);

  // 前月比: 為替影響と評価損益をざっくり分離（設計書 §2.2-1）
  let momHtml = '<div class="muted small">前月のスナップショットがまだありません</div>';
  if (prev && prev.totalJpy > 0) {
    const diff = total - prev.totalJpy;
    const pct = (diff / prev.totalJpy) * 100;
    const cls = diff >= 0 ? 'pos' : 'neg';
    let split = '';
    const fxNow = fxRate(state);
    if (fxNow && prev.fxUsdJpy) {
      const usdExposure = state.holdings
        .filter((h) => (h.price?.currency || h.currency) === 'USD')
        .reduce((s, h) => s + (Number(h.quantity) || 0) * (Number(h.price?.value) || 0), 0);
      const fxImpact = usdExposure * (fxNow - prev.fxUsdJpy);
      const other = diff - fxImpact;
      split = `<div class="muted small">内訳（概算）: 為替影響 ${fmtSignedJpy(fxImpact)} ／ 評価・入出金等 ${fmtSignedJpy(other)}</div>`;
    }
    momHtml = `<div class="mom ${cls}">${fmtSignedJpy(diff)}（${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%） <span class="muted small">vs ${esc(prev.date)}</span></div>${split}`;
  }

  // 待機資金メーター
  const ratioPct = Math.min(idle.ratio * 100, 100);
  const targetPct = Math.min(idle.max * 100, 100);
  const over = idle.ratio > idle.max;
  const idleThemes = state.themes
    .filter((t) => t.status === 'active')
    .sort((a, b) => (b.conviction || 0) - (a.conviction || 0))
    .slice(0, 3);
  const idleHint = over && idleThemes.length
    ? `<div class="warn-text small">約 ${fmtJpy(idle.excess)} が目標超過で待機中。テーマ別の投入候補（判断はご自身で）: ${idleThemes.map((t) => esc(t.name)).join('、')}</div>`
    : over
      ? `<div class="warn-text small">約 ${fmtJpy(idle.excess)} が目標超過で待機中。テーマ画面で投入先の仮説を整理できます。</div>`
      : '';

  // 配分データ
  const entries = allocEntries(byClass, byTheme, total);

  // 仮説あり・エクスポージャーゼロのテーマ（気づきの提示）
  const zeroThemes = state.themes.filter((t) => t.status === 'active' && !(byTheme[t.id] > 0));

  // 最近のインテル5件
  const recent = state.intel
    .filter((c) => !c.archived)
    .sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : -1)))
    .slice(0, 5);

  root.innerHTML = `
    <section class="card">
      <div class="label">総資産（円換算）</div>
      <div class="big">${fmtJpy(total)}</div>
      ${momHtml}
      <div class="muted small fx-note">
        USD/JPY ${fx ? `${fx.value.toFixed(2)}（${esc(fx.asOf || '-')} · ${esc(fx.source || '-')}）` : '未取得 — オフライン時は前回値/手動値を使用'}
        ／ 月次投資可能余力（概算）: ${fmtJpy(capacity)}
      </div>
    </section>

    <section class="card">
      <div class="row-between">
        <h2>待機資金メーター</h2>
        <span class="muted small">現金 + MMF</span>
      </div>
      <div class="meter">
        <div class="meter-fill ${over ? 'over' : ''}" style="width:${ratioPct.toFixed(1)}%"></div>
        <div class="meter-target" style="left:${targetPct.toFixed(1)}%" title="目標上限"></div>
      </div>
      <div class="row-between small">
        <span>現在 <b class="${over ? 'warn-text' : 'pos'}">${fmtPct(idle.ratio)}</b>（${fmtJpy(idle.idle)}）</span>
        <span class="muted">目標上限 ${fmtPct(idle.max, 0)}</span>
      </div>
      ${idleHint}
    </section>

    <section class="card">
      <div class="row-between">
        <h2>配分</h2>
        <div class="seg">
          <button class="seg-btn ${allocMode === 'class' ? 'on' : ''}" data-mode="class">クラス別</button>
          <button class="seg-btn ${allocMode === 'theme' ? 'on' : ''}" data-mode="theme">テーマ別</button>
        </div>
      </div>
      ${total > 0 ? `
        <div class="chart-wrap"><canvas id="allocChart" height="180"></canvas></div>
        <div class="alloc-list">
          ${entries.map((e, i) => `
            <div class="alloc-row">
              <span class="swatch" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>
              <span class="alloc-name">${esc(e.label)}</span>
              <span class="alloc-bar"><span style="width:${((e.value / total) * 100).toFixed(1)}%"></span></span>
              <span class="alloc-val">${fmtPct(e.value / total)}<br><span class="muted small">${fmtJpy(e.value)}</span></span>
            </div>`).join('')}
        </div>
        ${allocMode === 'theme' && zeroThemes.length ? `
          <div class="notice small">仮説はあるのにエクスポージャーゼロ: ${zeroThemes.map((t) => esc(t.name)).join('、')}</div>` : ''}
        ${allocMode === 'theme' ? '<div class="muted small">複数テーマに紐付く保有は均等按分しています</div>' : ''}
      ` : '<div class="empty">保有データがありません。ポートフォリオ画面から追加するか、設定画面でサンプルデータを読み込めます。</div>'}
    </section>

    <section class="card">
      <h2>要アクション</h2>
      ${actions.length ? `<div class="list">${actions.map((a, i) => `
        <div class="action-row">
          <button class="item action ${a.kind}" data-action-idx="${i}">
            <span class="action-icon">${a.type === 'trigger' ? '⏰' : a.kind === 'warn' ? '⚠️' : 'ℹ️'}</span>
            <span class="item-main">${esc(a.label)}</span>
            <span class="chev">›</span>
          </button>
          ${a.type === 'trigger' ? `<button class="btn small ack" data-ack-idx="${i}" title="確認済みにする（条件が再成立したら再表示）">確認<br>済み</button>` : ''}
        </div>`).join('')}</div>`
      : '<div class="empty">対応が必要な項目はありません。</div>'}
    </section>

    <section class="card">
      <div class="row-between"><h2>最近のインテル</h2><button class="btn small" id="goto-intel">受信箱へ</button></div>
      ${recent.length ? `<div class="list">${recent.map((c) => `
        <button class="item intel-brief" data-goto="intel">
          <span class="item-main">
            <span class="small muted">${esc(c.date || '')} ${sentimentDot(c.sentiment)}</span>
            <span class="intel-line">${esc(c.implication || c.aiSummary || c.title || c.rawNote || '(無題)')}</span>
          </span>
        </button>`).join('')}</div>`
      : '<div class="empty">インテルはまだありません。受信箱から URL やメモを投入できます。</div>'}
    </section>
  `;

  // イベント
  root.querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      allocMode = b.dataset.mode;
      render(root);
    });
  });
  root.querySelectorAll('[data-action-idx]').forEach((b) => {
    b.addEventListener('click', () => go(actions[Number(b.dataset.actionIdx)].view));
  });
  // トリガー成立の「確認済み」消し込み（再成立で再表示。設計書 §1.7）
  root.querySelectorAll('[data-ack-idx]').forEach((b) => {
    b.addEventListener('click', () => {
      const a = actions[Number(b.dataset.ackIdx)];
      const w = state.watchlist.find((x) => x.id === a.watchId);
      const tr = w?.triggers?.[a.triggerIndex];
      if (!tr) return;
      tr.ackAt = todayStr();
      touch(w);
      save();
      render(root);
      toast('確認済みにしました。条件が再成立したら再表示されます。');
    });
  });
  root.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => go(b.dataset.goto));
  });
  const gotoIntel = root.querySelector('#goto-intel');
  if (gotoIntel) gotoIntel.addEventListener('click', () => go('intel'));

  drawChart(root, entries);
}

function allocEntries(byClass, byTheme, total) {
  if (allocMode === 'class') {
    return Object.entries(ASSET_CLASSES)
      .map(([k, label]) => ({ label, value: byClass[k] || 0 }))
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value);
  }
  const entries = [];
  for (const [id, v] of Object.entries(byTheme)) {
    if (v <= 0) continue;
    const label = id === '_none' ? '未分類' : (state.themes.find((t) => t.id === id)?.name || '(削除済テーマ)');
    entries.push({ label, value: v });
  }
  return entries.sort((a, b) => b.value - a.value);
}

function drawChart(root, entries) {
  const cv = root.querySelector('#allocChart');
  if (!cv) return;
  // Chart.js（CDN）が読めない環境ではバーリストのみで表示を成立させる
  if (!window.Chart || !entries.length) {
    const wrap = cv.closest('.chart-wrap');
    if (wrap) wrap.style.display = 'none';
    return;
  }
  if (chart) {
    chart.destroy();
    chart = null;
  }
  chart = new Chart(cv, {
    type: 'doughnut',
    data: {
      labels: entries.map((e) => e.label),
      datasets: [{
        data: entries.map((e) => Math.round(e.value)),
        backgroundColor: entries.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        borderWidth: 0,
      }],
    },
    options: {
      cutout: '62%',
      plugins: { legend: { display: false } },
      animation: { duration: 300 },
    },
  });
}
