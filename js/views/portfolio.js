// ポートフォリオ — 保有一覧・編集・価格更新（設計書 §2.3）
import { state, save, newEntity, touch, todayStr } from '../state.js';
import {
  totals, holdingValueJpy, holdingCostJpy, ASSET_CLASSES, isPriceStale,
  accountById, findRestricted, evaluateTriggers,
} from '../derive.js';
import { esc, fmtJpy, fmtNum, toast, openModal, closeModal } from '../ui.js';
import { fetchFx, updateUsPrices } from '../api.js';
import { render as rerender } from '../app.js';

const ACCOUNT_TYPES = { bank: '銀行', securities: '証券', points: 'ポイント', other: 'その他' };

export function render(root) {
  const { total } = totals(state);
  const fx = state.fx.USDJPY;
  const holdings = [...state.holdings].sort(
    (a, b) => holdingValueJpy(b, state) - holdingValueJpy(a, state)
  );

  root.innerHTML = `
    <section class="card">
      <div class="row-between">
        <div>
          <div class="label">評価総額</div>
          <div class="big">${fmtJpy(total)}</div>
        </div>
        <div class="fx-box small">
          <div>USD/JPY <b>${fx ? fx.value.toFixed(2) : '未取得'}</b></div>
          <div class="muted">${fx ? `${esc(fx.asOf || '-')} · ${esc(fx.source || '-')}` : '設定画面で手動設定できます'}</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn" id="btn-fx">為替を更新</button>
        <button class="btn" id="btn-prices" ${state.settings.api.finnhubKey ? '' : 'disabled'}>米国株価を一括更新</button>
      </div>
      ${state.settings.api.finnhubKey ? '' : '<div class="muted small">Finnhub キー未設定のため一括更新は無効です（各銘柄の手動更新は可能）。設定画面から登録できます。</div>'}
    </section>

    <section class="card">
      <div class="row-between">
        <h2>保有資産</h2>
        <button class="btn small" id="btn-accounts">口座管理</button>
      </div>
      ${holdings.length ? `<div class="list">${holdings.map((h) => holdingRow(h)).join('')}</div>`
        : '<div class="empty">保有がありません。「＋ 保有を追加」から登録してください。</div>'}
      <button class="btn primary block" id="btn-add">＋ 保有を追加</button>
      <div class="muted small">価格の asOf が90日を超えた保有は <span class="stale">黄色</span> で表示されます（鮮度の見える化）。</div>
    </section>
  `;

  root.querySelector('#btn-fx').addEventListener('click', onFxUpdate);
  root.querySelector('#btn-prices').addEventListener('click', onBulkPrices);
  root.querySelector('#btn-add').addEventListener('click', () => openHoldingForm(null));
  root.querySelector('#btn-accounts').addEventListener('click', openAccountsModal);
  root.querySelectorAll('[data-holding]').forEach((el) => {
    el.addEventListener('click', () => {
      const h = state.holdings.find((x) => x.id === el.dataset.holding);
      if (h) openHoldingForm(h);
    });
  });
}

function holdingRow(h) {
  const v = holdingValueJpy(h, state);
  const acc = accountById(state, h.accountId);
  const stale = isPriceStale(h);
  const cur = h.price?.currency || h.currency || 'JPY';
  const priceStr = h.assetClass === 'cash'
    ? ''
    : ` · ${fmtNum(h.quantity)} × ${cur === 'USD' ? '$' : '¥'}${fmtNum(h.price?.value)}`;
  const asOf = h.assetClass === 'cash'
    ? ''
    : `<span class="asof ${stale ? 'stale' : ''}">（${esc(h.price?.asOf || '日付なし')} · ${esc(h.price?.source || 'manual')}）</span>`;
  const cost = holdingCostJpy(h, state);
  let plStr = '';
  if (cost && cost > 0 && h.assetClass !== 'cash') {
    const pl = ((v - cost) / cost) * 100;
    plStr = `<span class="${pl >= 0 ? 'pos' : 'neg'} small">${pl >= 0 ? '+' : ''}${pl.toFixed(1)}%</span>`;
  }
  return `
    <button class="item" data-holding="${esc(h.id)}">
      <span class="item-main">
        <span class="item-title">${esc(h.name || h.ticker || '(無名)')} ${h.ticker ? `<span class="tag">${esc(h.ticker)}</span>` : ''}</span>
        <span class="item-sub muted small">${esc(ASSET_CLASSES[h.assetClass] || h.assetClass)}${acc ? ' · ' + esc(acc.name) : ''}${priceStr} ${asOf}</span>
      </span>
      <span class="item-val">${fmtJpy(v)}<br>${plStr}</span>
    </button>`;
}

async function onFxUpdate(e) {
  e.target.disabled = true;
  const r = await fetchFx(state);
  e.target.disabled = false;
  if (r.ok) {
    save();
    toast(`為替を更新しました: USD/JPY ${r.value.toFixed(2)}`);
    rerender();
  } else {
    toast('為替の取得に失敗しました。前回値のまま継続します。');
  }
}

async function onBulkPrices(e) {
  e.target.disabled = true;
  toast('株価を更新中…');
  const r = await updateUsPrices(state);
  e.target.disabled = false;
  if (!r.ok) {
    toast('Finnhub キーが未設定です（設定画面から登録）');
    return;
  }
  save();
  rerender();
  const parts = [`株価更新: ${r.updated + (r.updatedWatch || 0)}/${r.total} 件成功`];
  if (r.fired > 0) parts.push(`トリガー成立 ${r.fired} 件（司令部参照）`);
  if (r.failed.length) parts.push(`失敗: ${r.failed.join(', ')} — 前回値のまま`);
  toast(parts.join(' ／ '));
}

// ---- 保有の追加・編集 ----

function openHoldingForm(h) {
  const isNew = !h;
  const d = h || {
    accountId: state.accounts[0]?.id || '',
    assetClass: 'us_equity',
    ticker: '', name: '', quantity: 0, avgCostLocal: 0, currency: 'USD',
    price: { value: 0, currency: 'USD', asOf: todayStr(), source: 'manual' },
    themeIds: [], recurring: null, note: '',
  };
  const modal = openModal(isNew ? '保有を追加' : '保有を編集', `
    <form id="holding-form">
      <label>口座
        <select name="accountId" required>
          ${state.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === d.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
      </label>
      ${state.accounts.length === 0 ? '<div class="warn-text small">口座がありません。先に「口座管理」から追加してください。</div>' : ''}
      <label>アセットクラス
        <select name="assetClass">
          ${Object.entries(ASSET_CLASSES).map(([k, l]) => `<option value="${k}" ${k === d.assetClass ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <div class="grid2">
        <label>ティッカー<input name="ticker" value="${esc(d.ticker || '')}" placeholder="NVDA（現金は空欄可）"></label>
        <label>名称<input name="name" value="${esc(d.name || '')}" required></label>
      </div>
      <div class="grid2">
        <label>数量<input name="quantity" type="number" step="any" value="${d.quantity ?? 0}"></label>
        <label>取得単価（現地通貨）<input name="avgCostLocal" type="number" step="any" value="${d.avgCostLocal ?? 0}"></label>
      </div>
      <div class="grid2">
        <label>通貨
          <select name="currency">
            <option value="JPY" ${d.currency === 'JPY' ? 'selected' : ''}>JPY</option>
            <option value="USD" ${d.currency === 'USD' ? 'selected' : ''}>USD</option>
          </select>
        </label>
        <label>価格（1単位）<input name="priceValue" type="number" step="any" value="${d.price?.value ?? 0}"></label>
      </div>
      <div class="grid2">
        <label>価格の通貨
          <select name="priceCurrency">
            <option value="JPY" ${(d.price?.currency || d.currency) === 'JPY' ? 'selected' : ''}>JPY</option>
            <option value="USD" ${(d.price?.currency || d.currency) === 'USD' ? 'selected' : ''}>USD</option>
          </select>
        </label>
        <label>価格の基準日<input name="priceAsOf" type="date" value="${esc(d.price?.asOf || todayStr())}"></label>
      </div>
      <div class="muted small">現金は「数量 = 金額、価格 = 1」で登録します。価格を手で変えると source は manual になります。</div>
      <fieldset><legend>テーマ（複数可）</legend>
        ${state.themes.length ? state.themes.map((t) => `
          <label class="check"><input type="checkbox" name="themeIds" value="${esc(t.id)}" ${(d.themeIds || []).includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>
        `).join('') : '<span class="muted small">テーマ未登録（テーマ画面から作成）</span>'}
      </fieldset>
      <div class="grid2">
        <label>定額積立（円/月）<input name="recurringAmount" type="number" value="${d.recurring?.amountJpy ?? ''}" placeholder="なしは空欄"></label>
        <label>積立日<input name="recurringDay" type="number" min="1" max="31" value="${d.recurring?.day ?? ''}"></label>
      </div>
      <label>メモ<textarea name="note" rows="2">${esc(d.note || '')}</textarea></label>
      <div class="btn-row">
        <button type="submit" class="btn primary">${isNew ? '追加' : '保存'}</button>
        ${isNew ? '' : '<button type="button" class="btn danger" id="btn-del">削除</button>'}
      </div>
    </form>
  `);

  modal.querySelector('#holding-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ticker = String(fd.get('ticker') || '').trim().toUpperCase();

    // 制限リスト照合（設計書 §0.3 / §2.3）
    const hit = findRestricted(state, ticker);
    if (hit) {
      const ok = confirm(`⚠ ${ticker} は制限リストに登録されています。\n理由: ${hit.reason || '-'}${hit.until ? `（期限: ${hit.until}）` : ''}\n\nこのまま登録しますか？`);
      if (!ok) return;
    }

    const priceValue = Number(fd.get('priceValue')) || 0;
    const priceChanged = isNew || priceValue !== (h.price?.value ?? 0);
    const recurringAmount = Number(fd.get('recurringAmount'));
    const target = isNew ? newEntity({}) : h;

    Object.assign(target, {
      accountId: fd.get('accountId'),
      assetClass: fd.get('assetClass'),
      ticker: ticker || null,
      name: String(fd.get('name') || '').trim(),
      quantity: Number(fd.get('quantity')) || 0,
      avgCostLocal: Number(fd.get('avgCostLocal')) || 0,
      currency: fd.get('currency'),
      price: {
        value: priceValue,
        currency: fd.get('priceCurrency'),
        asOf: fd.get('priceAsOf') || todayStr(),
        source: priceChanged ? 'manual' : (h?.price?.source || 'manual'),
      },
      themeIds: fd.getAll('themeIds'),
      recurring: recurringAmount > 0
        ? { amountJpy: recurringAmount, day: Number(fd.get('recurringDay')) || 1 }
        : null,
      note: String(fd.get('note') || ''),
    });
    touch(target);
    if (isNew) state.holdings.push(target);
    const fired = evaluateTriggers(state); // 手動の価格更新でも自動判定（Phase 2）
    save();
    closeModal();
    rerender();
    toast((isNew ? '保有を追加しました' : '保存しました') + (fired > 0 ? ` — トリガー成立 ${fired} 件` : ''));
  });

  const del = modal.querySelector('#btn-del');
  if (del) {
    del.addEventListener('click', () => {
      if (!confirm(`「${h.name}」を削除しますか？`)) return;
      state.holdings = state.holdings.filter((x) => x.id !== h.id);
      save();
      closeModal();
      rerender();
      toast('削除しました');
    });
  }
}

// ---- 口座管理 ----

function openAccountsModal() {
  const modal = openModal('口座管理', `
    <div class="list" id="acc-list">
      ${state.accounts.map((a) => `
        <div class="item static">
          <span class="item-main">
            <span class="item-title">${esc(a.name)}</span>
            <span class="item-sub muted small">${esc(ACCOUNT_TYPES[a.type] || a.type)}</span>
          </span>
          <button class="btn small" data-edit-acc="${esc(a.id)}">編集</button>
          <button class="btn small danger" data-del-acc="${esc(a.id)}">削除</button>
        </div>`).join('') || '<div class="empty">口座がありません</div>'}
    </div>
    <form id="acc-form" class="btn-row wrap">
      <input name="name" placeholder="口座名（例: SBI証券）" required>
      <select name="type">
        ${Object.entries(ACCOUNT_TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}
      </select>
      <button type="submit" class="btn primary">追加</button>
    </form>
  `);

  modal.querySelector('#acc-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.accounts.push(newEntity({ name: String(fd.get('name')).trim(), type: fd.get('type') }));
    save();
    closeModal();
    rerender();
    openAccountsModal();
  });

  modal.querySelectorAll('[data-edit-acc]').forEach((b) => {
    b.addEventListener('click', () => {
      const a = state.accounts.find((x) => x.id === b.dataset.editAcc);
      const name = prompt('口座名', a.name);
      if (name && name.trim()) {
        a.name = name.trim();
        touch(a);
        save();
        rerender();
        openAccountsModal();
      }
    });
  });

  modal.querySelectorAll('[data-del-acc]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.delAcc;
      if (state.holdings.some((holding) => holding.accountId === id)) {
        alert('この口座に保有が紐付いています。先に保有を移動または削除してください。');
        return;
      }
      if (!confirm('口座を削除しますか？')) return;
      state.accounts = state.accounts.filter((x) => x.id !== id);
      save();
      rerender();
      openAccountsModal();
    });
  });
}
