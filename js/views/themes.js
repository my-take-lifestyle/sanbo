// テーマ & ウォッチ（設計書 §1.6, §1.7, §2.3）
import { state, save, newEntity, touch, todayStr } from '../state.js';
import {
  totals, themeExposure, intelForTheme, holdingValueJpy, findRestricted,
  effectiveWatchPrice, evaluateTriggers, modelsForTicker,
} from '../derive.js';
import { esc, fmtJpy, toast, openModal, closeModal, sentimentDot, copyText } from '../ui.js';
import { buildThemeReviewPrompt } from '../prompts.js';
import { render as rerender, go } from '../app.js';

const STATUS_LABEL = { active: '進行中', watching: '観察中', closed: '終了' };
const WATCH_STATUS_LABEL = { watching: 'ウォッチ中', owned: '保有中', passed: '見送り' };
const TRIGGER_TYPES = { price_below: '株価が下回ったら', price_above: '株価が上回ったら', event: 'イベント' };

let watchFilter = 'active'; // active（watching+owned） | passed | all

export function render(root) {
  const themes = [...state.themes].sort((a, b) => (b.conviction || 0) - (a.conviction || 0));
  const watchItems = state.watchlist.filter((w) => {
    if (watchFilter === 'all') return true;
    if (watchFilter === 'passed') return w.status === 'passed';
    return w.status !== 'passed';
  });

  root.innerHTML = `
    <section class="card">
      <div class="row-between"><h2>テーマ</h2><button class="btn small primary" id="btn-add-theme">＋ 追加</button></div>
      ${themes.length ? themes.map((t) => themeCard(t)).join('')
        : '<div class="empty">テーマがありません。テーマ投資では銘柄よりテーマが上位概念です。まず仮説を1つ登録してください。</div>'}
    </section>

    <section class="card">
      <div class="row-between">
        <h2>ウォッチリスト</h2>
        <button class="btn small primary" id="btn-add-watch">＋ 追加</button>
      </div>
      <div class="seg">
        <button class="seg-btn ${watchFilter === 'active' ? 'on' : ''}" data-wf="active">ウォッチ/保有</button>
        <button class="seg-btn ${watchFilter === 'passed' ? 'on' : ''}" data-wf="passed">見送り</button>
        <button class="seg-btn ${watchFilter === 'all' ? 'on' : ''}" data-wf="all">すべて</button>
      </div>
      ${watchItems.length ? `<div class="list">${watchItems.map((w) => watchRow(w)).join('')}</div>`
        : '<div class="empty">該当するウォッチ銘柄がありません。</div>'}
      <div class="muted small">価格トリガーは価格更新のたびに自動判定され、成立すると司令部の「要アクション」に出ます。イベント型は週次レビューで手動確認してください。</div>
    </section>
  `;

  root.querySelector('#btn-add-theme').addEventListener('click', () => openThemeForm(null));
  root.querySelector('#btn-add-watch').addEventListener('click', () => openWatchForm(null));
  root.querySelectorAll('[data-wf]').forEach((b) => {
    b.addEventListener('click', () => {
      watchFilter = b.dataset.wf;
      render(root);
    });
  });
  root.querySelectorAll('[data-theme-card]').forEach((el) => {
    el.addEventListener('click', () => {
      const t = state.themes.find((x) => x.id === el.dataset.themeCard);
      if (t) openThemeDetail(t);
    });
  });
  root.querySelectorAll('[data-watch-item]').forEach((el) => {
    el.addEventListener('click', (e) => {
      // 参考シグナルバッジのタップはスコアボードへ（設計書 §5.2-5）
      if (e.target.closest('[data-goto-models]')) {
        go('models');
        return;
      }
      const w = state.watchlist.find((x) => x.id === el.dataset.watchItem);
      if (w) openWatchForm(w);
    });
  });
}

function stars(n) {
  const c = Math.max(0, Math.min(5, Number(n) || 0));
  return '★'.repeat(c) + '<span class="muted">' + '★'.repeat(5 - c) + '</span>';
}

function themeCard(t) {
  const exposure = themeExposure(state, t.id);
  const intelCount = intelForTheme(state, t.id).length;
  const noEdge = !(t.myEdge || '').trim();
  return `
    <button class="theme-card ${t.status === 'closed' ? 'closed' : ''}" data-theme-card="${esc(t.id)}">
      <div class="row-between">
        <span class="item-title">${esc(t.name)}</span>
        <span class="chip">${esc(STATUS_LABEL[t.status] || t.status)}</span>
      </div>
      <div class="small">確信度 ${stars(t.conviction)} <span class="muted">／ ${esc(t.horizon || '-')}</span></div>
      <div class="small">エクスポージャー <b>${fmtJpy(exposure)}</b> ・ インテル ${intelCount} 件</div>
      ${(t.kpis || []).length ? `<div class="chips">${t.kpis.map((k) => `<span class="chip soft">${esc(k)}</span>`).join('')}</div>` : ''}
      ${noEdge ? '<div class="warn-text small">⚠ myEdge（情報優位の源泉）が未記入です。書けないテーマは要注意。</div>' : ''}
    </button>`;
}

function watchRow(w) {
  const themeNames = (w.themeIds || [])
    .map((id) => state.themes.find((t) => t.id === id)?.name)
    .filter(Boolean);
  const price = effectiveWatchPrice(state, w);
  const fired = (w.triggers || []).some((tr) => tr.firedAt && !tr.ackAt);
  const pickModels = modelsForTicker(state, w.ticker);
  return `
    <button class="item" data-watch-item="${esc(w.id)}">
      <span class="item-main">
        <span class="item-title">${esc(w.ticker)} <span class="muted">${esc(w.name || '')}</span>
          <span class="chip soft">${esc(WATCH_STATUS_LABEL[w.status] || w.status)}</span>
          ${fired ? '<span class="chip warn">⏰ トリガー成立</span>' : ''}</span>
        <span class="item-sub muted small">${esc(w.whyWatch || '')}</span>
        ${price ? `<span class="item-sub small">現在値 ${esc(String(price.value))} <span class="muted">（${esc(price.asOf || '-')} · ${esc(price.source || '-')}）</span></span>` : ''}
        ${(w.triggers || []).length ? `<span class="item-sub small">⏱ ${w.triggers.map((tr) => esc(`${TRIGGER_TYPES[tr.type] || tr.type} ${tr.value}`)).join(' ／ ')}</span>` : ''}
        ${themeNames.length ? `<span class="item-sub muted small">🧭 ${themeNames.map(esc).join('、')}</span>` : ''}
        ${pickModels.length ? `<span class="item-sub small"><span class="chip soft" data-goto-models title="参考シグナル（一視点であり推奨ではありません）。タップでスコアボードへ">📈 ${pickModels.map((m) => esc(m.name)).join(' / ')}</span></span>` : ''}
      </span>
      <span class="chev">›</span>
    </button>`;
}

// ---- テーマ詳細 ----

function openThemeDetail(t) {
  const holdings = state.holdings.filter((h) => (h.themeIds || []).includes(t.id));
  const watch = state.watchlist.filter((w) => (w.themeIds || []).includes(t.id));
  const intel = intelForTheme(state, t.id);
  const modal = openModal(t.name, `
    <div class="detail-block">
      <div class="label">仮説（thesis）</div>
      <p>${esc(t.thesis || '未記入')}</p>
      <div class="label">自分の情報優位（myEdge）</div>
      <p>${t.myEdge ? esc(t.myEdge) : '<span class="warn-text">未記入 — なぜ自分が市場平均より良い判断ができるかを書いてください</span>'}</p>
      <div class="small">確信度 ${stars(t.conviction)} ／ 期間 ${esc(t.horizon || '-')} ／ ${esc(STATUS_LABEL[t.status] || t.status)}</div>
      ${(t.kpis || []).length ? `<div class="label">追うべき KPI</div><div class="chips">${t.kpis.map((k) => `<span class="chip soft">${esc(k)}</span>`).join('')}</div>` : ''}
      ${t.reviewNote ? `<div class="label">レビューノート</div><pre class="prewrap small">${esc(t.reviewNote)}</pre>` : ''}
      ${t.status === 'closed' && t.closedReason ? `<div class="label">終了理由</div><p>${esc(t.closedReason)}</p>` : ''}

      <div class="label">保有（${holdings.length}）</div>
      ${holdings.length ? holdings.map((h) => `<div class="mini-row">${esc(h.name)} <b>${fmtJpy(holdingValueJpy(h, state))}</b></div>`).join('') : '<p class="muted small">エクスポージャーなし</p>'}

      <div class="label">ウォッチ（${watch.length}）</div>
      ${watch.length ? watch.map((w) => `<div class="mini-row">${esc(w.ticker)} <span class="muted small">${esc(w.whyWatch || '')}</span></div>`).join('') : '<p class="muted small">なし</p>'}

      <div class="label">インテル・タイムライン（${intel.length}）</div>
      ${intel.length ? intel.slice(0, 20).map((c) => `
        <div class="mini-row timeline">${sentimentDot(c.sentiment)} <span class="muted small">${esc(c.date || '')}</span>
        ${esc(c.implication || c.aiSummary || c.title || c.rawNote || '').slice(0, 120)}</div>`).join('')
      : '<p class="muted small">まだ情報がありません</p>'}
    </div>
    <div class="btn-row">
      <button class="btn primary" id="btn-edit-theme">編集</button>
      <button class="btn" id="btn-theme-review">📋 テーマレビュー</button>
      <button class="btn" id="btn-close-detail">閉じる</button>
    </div>
    <div class="muted small">テーマレビュー: 四半期用のレビュープロンプト（反証材料・KPI・エクスポージャー過不足）を生成してコピーします。AI の回答はインテル受信箱の貼り戻し欄へ。</div>
  `);
  modal.querySelector('#btn-edit-theme').addEventListener('click', () => openThemeForm(t));
  modal.querySelector('#btn-close-detail').addEventListener('click', closeModal);
  modal.querySelector('#btn-theme-review').addEventListener('click', async () => {
    const prompt = buildThemeReviewPrompt(state, t);
    const ok = await copyText(prompt);
    if (ok) {
      toast('テーマレビュープロンプトをコピーしました。AI の回答はインテル受信箱へ貼り戻してください。');
    } else {
      openModal(`テーマレビュー: ${t.name}（手動でコピー）`, `<textarea rows="14" readonly>${esc(prompt)}</textarea>`);
    }
  });
}

// ---- テーマ編集 ----

function openThemeForm(t) {
  const isNew = !t;
  const d = t || { name: '', thesis: '', myEdge: '', conviction: 3, horizon: '3-5y', status: 'active', kpis: [], reviewNote: '', closedReason: null };
  const modal = openModal(isNew ? 'テーマを追加' : 'テーマを編集', `
    <form id="theme-form">
      <label>テーマ名<input name="name" value="${esc(d.name)}" required placeholder="例: データセンター（電力・冷却・素材）"></label>
      <label>仮説（thesis）<textarea name="thesis" rows="3" placeholder="なぜこのテーマが伸びるのか">${esc(d.thesis || '')}</textarea></label>
      <label>自分の情報優位（myEdge）<textarea name="myEdge" rows="2" placeholder="なぜ自分がこのテーマで市場平均より良い判断ができるか">${esc(d.myEdge || '')}</textarea></label>
      <div class="grid2">
        <label>確信度（1-5）
          <select name="conviction">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === (d.conviction || 3) ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <label>投資期間<input name="horizon" value="${esc(d.horizon || '')}" placeholder="3-5y"></label>
      </div>
      <label>状態
        <select name="status">
          ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${k === d.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <label>KPI（カンマ区切り）<input name="kpis" value="${esc((d.kpis || []).join(', '))}" placeholder="hyperscaler capex, 電力PPA価格"></label>
      <label>レビューノート<textarea name="reviewNote" rows="2">${esc(d.reviewNote || '')}</textarea></label>
      <label>終了理由（closed の場合）<input name="closedReason" value="${esc(d.closedReason || '')}"></label>
      <div class="btn-row">
        <button type="submit" class="btn primary">${isNew ? '追加' : '保存'}</button>
        ${isNew ? '' : '<button type="button" class="btn danger" id="btn-del-theme">削除</button>'}
      </div>
    </form>
  `);

  modal.querySelector('#theme-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const target = isNew ? newEntity({}) : t;
    Object.assign(target, {
      name: String(fd.get('name')).trim(),
      thesis: String(fd.get('thesis') || ''),
      myEdge: String(fd.get('myEdge') || ''),
      conviction: Number(fd.get('conviction')) || 3,
      horizon: String(fd.get('horizon') || ''),
      status: fd.get('status'),
      kpis: String(fd.get('kpis') || '').split(',').map((s) => s.trim()).filter(Boolean),
      reviewNote: String(fd.get('reviewNote') || ''),
      closedReason: String(fd.get('closedReason') || '') || null,
    });
    touch(target);
    if (isNew) state.themes.push(target);
    save();
    closeModal();
    rerender();
    toast(isNew ? 'テーマを追加しました' : '保存しました');
  });

  const del = modal.querySelector('#btn-del-theme');
  if (del) {
    del.addEventListener('click', () => {
      if (!confirm(`テーマ「${t.name}」を削除しますか？（保有・ウォッチ・インテルからの紐付けも外れます）`)) return;
      state.themes = state.themes.filter((x) => x.id !== t.id);
      for (const h of state.holdings) h.themeIds = (h.themeIds || []).filter((id) => id !== t.id);
      for (const w of state.watchlist) w.themeIds = (w.themeIds || []).filter((id) => id !== t.id);
      for (const c of state.intel) c.themeIds = (c.themeIds || []).filter((id) => id !== t.id);
      save();
      closeModal();
      rerender();
      toast('削除しました');
    });
  }
}

// ---- ウォッチ編集 ----

function openWatchForm(w) {
  const isNew = !w;
  const d = w || { ticker: '', name: '', market: '', themeIds: [], whyWatch: '', triggers: [], status: 'watching', passedReason: null, lastPrice: null };
  const modal = openModal(isNew ? 'ウォッチ銘柄を追加' : 'ウォッチ銘柄を編集', `
    <form id="watch-form">
      <div class="grid2">
        <label>ティッカー<input name="ticker" value="${esc(d.ticker)}" required placeholder="VRT"></label>
        <label>名称<input name="name" value="${esc(d.name || '')}" placeholder="Vertiv"></label>
      </div>
      <label>市場<input name="market" value="${esc(d.market || '')}" placeholder="NYSE"></label>
      <fieldset><legend>テーマ（複数可）</legend>
        ${state.themes.length ? state.themes.map((t) => `
          <label class="check"><input type="checkbox" name="themeIds" value="${esc(t.id)}" ${(d.themeIds || []).includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>
        `).join('') : '<span class="muted small">テーマ未登録</span>'}
      </fieldset>
      <label>ウォッチ理由（whyWatch）<textarea name="whyWatch" rows="2">${esc(d.whyWatch || '')}</textarea></label>
      <fieldset><legend>トリガー（見直し条件）</legend>
        <div id="trigger-rows">${(d.triggers || []).map((tr) => triggerRowHtml(tr)).join('')}</div>
        <button type="button" class="btn small" id="btn-add-trigger">＋ 条件を追加</button>
      </fieldset>
      <label>現在価格（判定用・トリガーと同じ通貨で）
        <input name="lastPriceValue" type="number" step="any" value="${d.lastPrice?.value ?? ''}"
          placeholder="Finnhub 一括更新でも自動取得されます">
      </label>
      <div class="muted small">価格系トリガーはこの価格（無ければ同一ティッカーの保有価格）で自動判定されます。</div>
      <div class="grid2">
        <label>状態
          <select name="status">
            ${Object.entries(WATCH_STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${k === d.status ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>見送り理由（passed の場合）<input name="passedReason" value="${esc(d.passedReason || '')}"></label>
      </div>
      <div class="btn-row">
        <button type="submit" class="btn primary">${isNew ? '追加' : '保存'}</button>
        ${isNew ? '' : '<button type="button" class="btn danger" id="btn-del-watch">削除</button>'}
      </div>
    </form>
  `);

  modal.querySelector('#btn-add-trigger').addEventListener('click', () => {
    modal.querySelector('#trigger-rows').insertAdjacentHTML('beforeend', triggerRowHtml({}));
    bindTriggerRemove(modal);
  });
  bindTriggerRemove(modal);

  modal.querySelector('#watch-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ticker = String(fd.get('ticker')).trim().toUpperCase();

    // 制限リスト照合警告（設計書 §0.3: 参謀としての最重要の守り）
    const hit = findRestricted(state, ticker);
    if (hit) {
      const ok = confirm(`⚠ ${ticker} は制限リストに登録されています。\n理由: ${hit.reason || '-'}${hit.until ? `（期限: ${hit.until}）` : ''}\n\nこのままウォッチに追加しますか？`);
      if (!ok) return;
    }

    const types = fd.getAll('trigType');
    const values = fd.getAll('trigValue');
    const notes = fd.getAll('trigNote');
    const triggers = [];
    for (let i = 0; i < types.length; i++) {
      const value = String(values[i] || '').trim();
      const note = String(notes[i] || '').trim();
      if (!value && !note) continue;
      const type = types[i];
      const normalized = type === 'event' ? value : (Number(value) || value);
      // 条件が同じ既存トリガーの成立/確認済み状態は引き継ぐ
      const prev = (w?.triggers || []).find(
        (o) => o.type === type && String(o.value) === String(normalized)
      );
      triggers.push({
        type,
        value: normalized,
        note,
        firedAt: prev?.firedAt ?? null,
        ackAt: prev?.ackAt ?? null,
      });
    }

    // 手動価格: 値が変わったら manual として記録。空欄なら既存値を維持
    const lastPriceValue = Number(fd.get('lastPriceValue'));
    let lastPrice = w?.lastPrice ?? null;
    if (lastPriceValue > 0 && lastPriceValue !== (w?.lastPrice?.value ?? null)) {
      lastPrice = { value: lastPriceValue, asOf: todayStr(), source: 'manual' };
    } else if (!(lastPriceValue > 0)) {
      lastPrice = null;
    }

    const target = isNew ? newEntity({}) : w;
    Object.assign(target, {
      ticker,
      name: String(fd.get('name') || '').trim(),
      market: String(fd.get('market') || '').trim(),
      themeIds: fd.getAll('themeIds'),
      whyWatch: String(fd.get('whyWatch') || ''),
      triggers,
      status: fd.get('status'),
      passedReason: String(fd.get('passedReason') || '') || null,
      lastPrice,
    });
    touch(target);
    if (isNew) state.watchlist.push(target);
    const fired = evaluateTriggers(state); // 手動価格更新でも自動判定（Phase 2）
    save();
    closeModal();
    rerender();
    toast((isNew ? 'ウォッチに追加しました' : '保存しました') + (fired > 0 ? ` — トリガー成立 ${fired} 件` : ''));
  });

  const del = modal.querySelector('#btn-del-watch');
  if (del) {
    del.addEventListener('click', () => {
      if (!confirm(`${w.ticker} をウォッチリストから削除しますか？`)) return;
      state.watchlist = state.watchlist.filter((x) => x.id !== w.id);
      save();
      closeModal();
      rerender();
      toast('削除しました');
    });
  }
}

function triggerRowHtml(tr) {
  return `
    <div class="trigger-row">
      <select name="trigType">
        ${Object.entries(TRIGGER_TYPES).map(([k, l]) => `<option value="${k}" ${k === tr.type ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input name="trigValue" value="${esc(tr.value ?? '')}" placeholder="値/内容">
      <input name="trigNote" value="${esc(tr.note || '')}" placeholder="メモ">
      <button type="button" class="btn small danger trig-del">×</button>
    </div>`;
}

function bindTriggerRemove(modal) {
  modal.querySelectorAll('.trig-del').forEach((b) => {
    b.onclick = () => b.closest('.trigger-row').remove();
  });
}
