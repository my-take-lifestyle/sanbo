// ジャーナル — 意思決定記録・6か月レビュー（設計書 §1.8, §2.3。Phase 2）
// Decision は約定記録ではなく判断記録。金額は概算でよい。
import { state, save, newEntity, touch, todayStr, addMonths } from '../state.js';
import { DECISION_ACTIONS, decisionsDueForReview } from '../derive.js';
import { esc, fmtJpy, toast, openModal, closeModal } from '../ui.js';
import { render as rerender } from '../app.js';

const JUDGMENT_LABEL = { good: '良い判断', fair: '妥当', bad: '悪い判断' };
const OUTCOME_LABEL = { good: '良い結果', neutral: '中立', bad: '悪い結果' };

let filter = 'all'; // all | due | reviewed

export function render(root) {
  const due = decisionsDueForReview(state);
  const items = [...state.decisions]
    .filter((d) => {
      if (filter === 'due') return due.includes(d);
      if (filter === 'reviewed') return !!d.review?.outcome;
      return true;
    })
    .sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));

  root.innerHTML = `
    <section class="card">
      <div class="row-between">
        <h2>意思決定ジャーナル</h2>
        <button class="btn small primary" id="btn-add-decision">＋ 起票</button>
      </div>
      <p class="muted small">約定記録ではなく判断記録です。良い判断が悪い結果になることはあります —
      6か月後に「判断の質」と「結果」を分けて振り返ります。見送り（pass）も学習価値が高いので記録を。</p>
      <div class="seg">
        <button class="seg-btn ${filter === 'all' ? 'on' : ''}" data-jf="all">すべて</button>
        <button class="seg-btn ${filter === 'due' ? 'on' : ''}" data-jf="due">レビュー待ち${due.length ? ` (${due.length})` : ''}</button>
        <button class="seg-btn ${filter === 'reviewed' ? 'on' : ''}" data-jf="reviewed">レビュー済み</button>
      </div>
      ${items.length ? `<div class="list">${items.map((d) => decisionRow(d)).join('')}</div>`
        : '<div class="empty">記録がありません。売買・見送り・リバランスの判断を「起票」から残せます。</div>'}
    </section>
  `;

  root.querySelector('#btn-add-decision').addEventListener('click', () => openDecisionForm(null));
  root.querySelectorAll('[data-jf]').forEach((b) => {
    b.addEventListener('click', () => {
      filter = b.dataset.jf;
      render(root);
    });
  });
  root.querySelectorAll('[data-decision]').forEach((el) => {
    el.addEventListener('click', () => {
      const d = state.decisions.find((x) => x.id === el.dataset.decision);
      if (d) openDecisionForm(d);
    });
  });
}

function decisionRow(d) {
  const theme = state.themes.find((t) => t.id === d.themeId);
  const r = d.review || {};
  let reviewHtml;
  if (r.outcome) {
    reviewHtml = `<span class="pos small">✓ レビュー済み — 判断: ${esc(JUDGMENT_LABEL[r.judgmentQuality] || '-')} ／ 結果: ${esc(OUTCOME_LABEL[r.outcome] || '-')}</span>`;
  } else if (r.dueDate && r.dueDate <= todayStr()) {
    reviewHtml = `<span class="warn-text small">⚠ レビュー期限到来（${esc(r.dueDate)}）</span>`;
  } else if (r.dueDate) {
    reviewHtml = `<span class="muted small">レビュー予定 ${esc(r.dueDate)}</span>`;
  } else {
    reviewHtml = '<span class="muted small">レビュー予定なし</span>';
  }
  return `
    <button class="item" data-decision="${esc(d.id)}">
      <span class="item-main">
        <span class="item-title">
          <span class="muted small">${esc(d.date || '')}</span>
          <span class="chip">${esc(DECISION_ACTIONS[d.action] || d.action)}</span>
          ${d.ticker ? `<span class="tag">${esc(d.ticker)}</span>` : ''}
          ${d.amountJpy ? `<span class="small">${fmtJpy(d.amountJpy)}</span>` : ''}
        </span>
        ${d.rationale ? `<span class="item-sub small">${esc(d.rationale.slice(0, 100))}</span>` : ''}
        ${theme ? `<span class="item-sub muted small">🧭 ${esc(theme.name)}</span>` : ''}
        <span class="item-sub">${reviewHtml}</span>
      </span>
      <span class="chev">›</span>
    </button>`;
}

function openDecisionForm(d) {
  const isNew = !d;
  const today = todayStr();
  const data = d || {
    date: today,
    action: 'buy',
    ticker: '',
    amountJpy: 0,
    rationale: '',
    intelIds: [],
    themeId: '',
    review: { dueDate: addMonths(today, 6), judgmentQuality: null, outcome: null, lesson: null },
  };
  const r = data.review || {};
  const recentIntel = state.intel
    .filter((c) => !c.archived)
    .sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1))
    .slice(0, 15);

  const modal = openModal(isNew ? '判断を起票' : '判断の編集 / レビュー', `
    <form id="decision-form">
      <div class="grid2">
        <label>判断日<input name="date" type="date" value="${esc(data.date || today)}" required></label>
        <label>種別
          <select name="action">
            ${Object.entries(DECISION_ACTIONS).map(([k, l]) => `<option value="${k}" ${k === data.action ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="grid2">
        <label>ティッカー / 対象<input name="ticker" value="${esc(data.ticker || '')}" placeholder="NVDA（任意）"></label>
        <label>金額（円・概算）<input name="amountJpy" type="number" value="${data.amountJpy || 0}"></label>
      </div>
      <label>テーマ
        <select name="themeId">
          <option value="">（なし）</option>
          ${state.themes.map((t) => `<option value="${esc(t.id)}" ${t.id === data.themeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
      </label>
      <label>判断理由（当時の仮説を残す）<textarea name="rationale" rows="3" required>${esc(data.rationale || '')}</textarea></label>
      ${recentIntel.length ? `
      <fieldset><legend>根拠にしたインテル（任意・複数可）</legend>
        ${recentIntel.map((c) => `
          <label class="check"><input type="checkbox" name="intelIds" value="${esc(c.id)}" ${(data.intelIds || []).includes(c.id) ? 'checked' : ''}>
          <span class="small">${esc(c.date || '')} ${esc((c.title || c.implication || c.rawNote || '(無題)').slice(0, 50))}</span></label>
        `).join('')}
      </fieldset>` : ''}
      <label>レビュー期限（起票時に +6か月で自動設定）<input name="dueDate" type="date" value="${esc(r.dueDate || addMonths(today, 6))}"></label>

      <fieldset><legend>レビュー（期限到来後に記入。質と結果は別物）</legend>
        <div class="grid2">
          <label>判断の質
            <select name="judgmentQuality">
              <option value="">未記入</option>
              ${Object.entries(JUDGMENT_LABEL).map(([k, l]) => `<option value="${k}" ${k === r.judgmentQuality ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
          <label>結果
            <select name="outcome">
              <option value="">未記入</option>
              ${Object.entries(OUTCOME_LABEL).map(([k, l]) => `<option value="${k}" ${k === r.outcome ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
        </div>
        <label>学び（lesson）<textarea name="lesson" rows="2" placeholder="当時の情報で他に何ができたか / 次に活かすこと">${esc(r.lesson || '')}</textarea></label>
      </fieldset>

      <div class="btn-row">
        <button type="submit" class="btn primary">${isNew ? '起票' : '保存'}</button>
        ${isNew ? '' : '<button type="button" class="btn danger" id="btn-del-decision">削除</button>'}
      </div>
    </form>
  `);

  modal.querySelector('#decision-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const target = isNew ? newEntity({}) : d;
    Object.assign(target, {
      date: fd.get('date') || today,
      action: fd.get('action'),
      ticker: String(fd.get('ticker') || '').trim().toUpperCase(),
      amountJpy: Number(fd.get('amountJpy')) || 0,
      rationale: String(fd.get('rationale') || ''),
      intelIds: fd.getAll('intelIds'),
      themeId: fd.get('themeId') || '',
      review: {
        dueDate: fd.get('dueDate') || addMonths(today, 6),
        judgmentQuality: fd.get('judgmentQuality') || null,
        outcome: fd.get('outcome') || null,
        lesson: String(fd.get('lesson') || '') || null,
      },
    });
    touch(target);
    if (isNew) state.decisions.push(target);
    save();
    closeModal();
    rerender();
    toast(isNew ? '起票しました（6か月後にレビュー期限が来ます）' : '保存しました');
  });

  const del = modal.querySelector('#btn-del-decision');
  if (del) {
    del.addEventListener('click', () => {
      if (!confirm('この判断記録を削除しますか？（振り返りの材料が失われます）')) return;
      state.decisions = state.decisions.filter((x) => x.id !== d.id);
      save();
      closeModal();
      rerender();
      toast('削除しました');
    });
  }
}
