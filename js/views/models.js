// モデル選定エンジン — スコアボード・月次実行・ベンチマーク（設計書 §5.2。Phase 4）
// 「モデル」= 構造化プロンプト + 仮想ポートフォリオ + 成績記録。自動売買・自動執行はしない。
// ピックは参考シグナルであり推奨ではない（UI 文言もこの立場を崩さない）。
import { state, save, newEntity, touch, todayStr, nowIso } from '../state.js';
import {
  modelStats, modelPicksFor, pickPerformance, effectivePickPrice,
  modelsDueThisMonth, benchmarkLatest, recordBenchmark, findRestricted,
  BENCHMARKS, pickBenchmarkKey, isJpTicker,
} from '../derive.js';
import { esc, toast, openModal, closeModal, copyText } from '../ui.js';
import { buildModelRunPrompt } from '../prompts.js';
import { extractPasteback, applyModelPicks } from '../parse.js';
import { fetchQuoteFinnhub } from '../api.js';
import { render as rerender } from '../app.js';

let modelFilter = 'active'; // active | retired | all

function fmtSignedPct(x, digits = 1) {
  if (x === null || x === undefined) return '—';
  const v = x * 100;
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + '%';
}

function relClass(x) {
  if (x === null || x === undefined) return 'muted';
  return x >= 0 ? 'pos' : 'neg';
}

export function render(root) {
  const models = state.models.filter((m) => {
    if (modelFilter === 'all') return true;
    if (modelFilter === 'retired') return m.status === 'retired';
    return m.status === 'active';
  });
  const withStats = models
    .map((m) => ({ m, s: modelStats(state, m) }))
    .sort((a, b) => (b.s.relReturn ?? -Infinity) - (a.s.relReturn ?? -Infinity));
  const due = modelsDueThisMonth(state);
  const ym = todayStr().slice(0, 7);
  const spy = benchmarkLatest(state, 'SPY');
  const tpx = benchmarkLatest(state, '1306');

  root.innerHTML = `
    <section class="card">
      <div class="row-between">
        <h2>モデル・スコアボード</h2>
        <button class="btn small primary" id="btn-add-model">＋ モデル追加</button>
      </div>
      <p class="muted small">複数の直交する視点で仮説を出させ、実績で選別する仕組みです（設計書 §5.2）。
      ピックは<b>参考シグナルであり推奨ではありません</b>。四半期ごとに成績下位モデルの retire と新モデル（新しい論文・視点）の投入を検討してください。</p>
      <div class="seg">
        <button class="seg-btn ${modelFilter === 'active' ? 'on' : ''}" data-mf="active">稼働中</button>
        <button class="seg-btn ${modelFilter === 'retired' ? 'on' : ''}" data-mf="retired">retire済み</button>
        <button class="seg-btn ${modelFilter === 'all' ? 'on' : ''}" data-mf="all">すべて</button>
      </div>
      ${withStats.length ? withStats.map(({ m, s }) => modelCard(m, s)).join('')
        : '<div class="empty">該当するモデルがありません。</div>'}
    </section>

    <section class="card ai-panel">
      <h2>月次モデル実行（コピペ）</h2>
      <p class="muted small">1. 各モデルの実行プロンプトをコピーして AI チャットに貼る → 2. 回答全文を下に貼り戻す → 3. 取り込む。
      仮想エントリー価格は既知の価格（保有/ウォッチ${state.settings.api.finnhubKey ? ' + Finnhub' : ''}）から自動設定されます。</p>
      ${state.models.filter((m) => m.status === 'active').map((m) => {
        const done = state.modelPicks.some((p) => p.modelId === m.id && (p.date || '').startsWith(ym));
        return `
        <div class="btn-row">
          <button class="btn" data-run-model="${esc(m.id)}">📋 ${esc(m.name)}</button>
          <span class="chip ${done ? 'soft' : 'warn'}">${done ? '今月 ✓' : '今月 未実行'}</span>
        </div>`;
      }).join('') || '<div class="empty">active なモデルがありません。</div>'}
      <textarea id="picks-paste" rows="4" placeholder="AI の回答（modelPicks の JSON ブロックを含む全文）をここに貼り付け"></textarea>
      <button class="btn block" id="btn-apply-picks">ピックを取り込む</button>
    </section>

    <section class="card">
      <h2>ベンチマーク価格</h2>
      <div class="small">
        ${BENCHMARKS.SPY}: <b>${spy ? spy.value : '未記録'}</b> <span class="muted">${spy ? `（${esc(spy.date)}）` : ''}</span> ／
        ${BENCHMARKS['1306']}: <b>${tpx ? tpx.value : '未記録'}</b> <span class="muted">${tpx ? `（${esc(tpx.date)}）` : ''}</span>
      </div>
      <form id="bench-form" class="btn-row wrap">
        <select name="key">
          ${Object.entries(BENCHMARKS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}
        </select>
        <input name="value" type="number" step="any" placeholder="価格" required>
        <button type="submit" class="btn">今日の値として記録</button>
      </form>
      <div class="muted small">SPY は「米国株価を一括更新」でも自動記録されます。1306（東証）は手動記録です。
      記録が無い期間の相対リターンは欠損としてスキップされます（計算は止まりません）。</div>
    </section>
  `;

  root.querySelectorAll('[data-mf]').forEach((b) => {
    b.addEventListener('click', () => {
      modelFilter = b.dataset.mf;
      render(root);
    });
  });
  root.querySelector('#btn-add-model').addEventListener('click', () => openModelForm(null));
  root.querySelectorAll('[data-model-card]').forEach((el) => {
    el.addEventListener('click', () => {
      const m = state.models.find((x) => x.id === el.dataset.modelCard);
      if (m) openModelDetail(m);
    });
  });
  root.querySelectorAll('[data-run-model]').forEach((b) => {
    b.addEventListener('click', async () => {
      const m = state.models.find((x) => x.id === b.dataset.runModel);
      if (!m) return;
      const prompt = buildModelRunPrompt(state, m);
      const ok = await copyText(prompt);
      if (ok) {
        toast(`「${m.name}」の実行プロンプトをコピーしました。回答は下の貼り戻し欄へ。`);
      } else {
        openModal(`実行プロンプト: ${m.name}（手動でコピー）`, `<textarea rows="14" readonly>${esc(prompt)}</textarea>`);
      }
    });
  });
  root.querySelector('#btn-apply-picks').addEventListener('click', () => {
    applyPicksFromText(root.querySelector('#picks-paste').value);
  });
  root.querySelector('#bench-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const v = Number(fd.get('value'));
    if (!(v > 0)) {
      toast('有効な価格を入力してください');
      return;
    }
    recordBenchmark(state, fd.get('key'), v, todayStr());
    save();
    rerender();
    toast('ベンチマーク価格を記録しました');
  });
}

function modelCard(m, s) {
  const period = s.since ? `${s.since} 〜 ${s.until}` : '未稼働';
  return `
    <button class="theme-card ${m.status === 'retired' ? 'closed' : ''}" data-model-card="${esc(m.id)}">
      <div class="row-between">
        <span class="item-title">${esc(m.name)}</span>
        <span class="chip ${m.status === 'active' ? 'soft' : ''}">${m.status === 'active' ? '稼働中' : 'retire済み'}</span>
      </div>
      <div class="small">
        累積相対リターン <b class="${relClass(s.relReturn)}">${fmtSignedPct(s.relReturn)}</b>
        ・ ヒット率 ${s.hitRate === null ? '—' : Math.round(s.hitRate * 100) + '%'}
        ・ ピック ${s.pickCount} 件${s.excluded ? `（うち計算対象外 ${s.excluded}）` : ''}
      </div>
      <div class="muted small">${esc(period)} ／ ${esc((m.origin || '').slice(0, 60))}</div>
    </button>`;
}

// ---- 貼り戻し取り込み ----

export function applyPicksFromText(text) {
  if (!text.trim()) {
    toast('貼り戻すテキストが空です');
    return;
  }
  const parsed = extractPasteback(text);
  if (!parsed) {
    toast('JSON を解釈できませんでした（modelPicks ブロックが必要です）');
    return;
  }
  if (parsed.type !== 'modelPicks') {
    toast('これは週次ブリーフィング/テーマレビューの回答です。インテル受信箱の貼り戻し欄をご利用ください。');
    return;
  }
  const data = parsed.data;

  // 制限リスト照合（設計書 §0.3。受け入れ基準2）
  const restrictedHits = [...new Set(
    (data.picks || [])
      .map((p) => String(p.ticker || '').trim().toUpperCase())
      .filter((t) => t && findRestricted(state, t))
  )];
  let exclude = new Set();
  if (restrictedHits.length) {
    const keep = confirm(
      `⚠ 制限リストに登録された銘柄が含まれています: ${restrictedHits.join(', ')}\n\n` +
      'OK: 含めて記録（仮想ピックであっても取引自粛対象である点に注意）\n' +
      'キャンセル: 制限銘柄を除外して記録'
    );
    if (!keep) exclude = new Set(restrictedHits);
  }

  const r = applyModelPicks(state, data, exclude);
  if (!r) {
    toast('モデル名を解決できませんでした。スコアボードのモデル名と一致させてください（データは保存されていません）。');
    return;
  }
  save();
  rerender();
  toast(`${r.model.name}: ピック ${r.created.length} 件を記録しました${r.skipped ? `（除外 ${r.skipped} 件）` : ''}`);
  fillEntryPricesAsync(r.created);
}

// エントリー価格が未解決の米国銘柄を Finnhub で補完し、SPY ベンチマークも記録する
async function fillEntryPricesAsync(picks) {
  const key = state.settings.api.finnhubKey;
  if (!key) return;
  let touched = false;
  try {
    const q = await fetchQuoteFinnhub('SPY', key);
    recordBenchmark(state, 'SPY', q.value, q.asOf);
    touched = true;
  } catch (e) { /* 欠損 */ }
  for (const p of picks) {
    if (Number(p.entryPrice) > 0 || isJpTicker(p.ticker)) continue;
    try {
      const q = await fetchQuoteFinnhub(p.ticker, key);
      p.entryPrice = q.value;
      p.lastPrice = { ...q };
      touch(p);
      touched = true;
    } catch (e) { /* 手動で補完 */ }
  }
  if (touched) {
    save();
    rerender();
    toast('エントリー価格とベンチマークを自動補完しました');
  }
}

// ---- モデル詳細 ----

function openModelDetail(m) {
  const s = modelStats(state, m);
  const picks = modelPicksFor(state, m.id);
  const modal = openModal(m.name, `
    <div class="detail-block">
      <div class="small">
        <span class="chip ${m.status === 'active' ? 'soft' : ''}">${m.status === 'active' ? '稼働中' : 'retire済み'}</span>
        累積相対リターン <b class="${relClass(s.relReturn)}">${fmtSignedPct(s.relReturn)}</b>
        ・ ヒット率 ${s.hitRate === null ? '—' : Math.round(s.hitRate * 100) + '%'}
        ・ 相対リターン計算対象 ${s.covered}/${s.pickCount} 件
      </div>
      ${s.since ? `<div class="muted small">稼働期間: ${esc(s.since)} 〜 ${esc(s.until)}</div>` : ''}
      ${m.status === 'retired' ? `<div class="muted small">retire: ${esc((m.retiredAt || '').slice(0, 10))} — ${esc(m.retiredReason || '理由未記入')}</div>` : ''}
      <div class="label">出典・由来（origin）</div>
      <p class="small">${esc(m.origin || '未記入')}</p>
      <div class="label">選定ロジック（logicPrompt）</div>
      <pre class="prewrap small">${esc(m.logicPrompt || '')}</pre>

      <div class="label">ピック履歴（${picks.length}）</div>
      ${picks.length ? picks.map((p) => pickRow(p)).join('') : '<p class="muted small">まだピックがありません。</p>'}
      <button class="btn small" id="btn-add-pick">＋ ピックを手動追加</button>
    </div>
    <div class="btn-row">
      <button class="btn primary" id="btn-edit-model">編集</button>
      ${m.status === 'active'
        ? '<button class="btn danger" id="btn-retire-model">retire</button>'
        : '<button class="btn" id="btn-revive-model">稼働に戻す</button>'}
      <button class="btn" id="btn-close-model">閉じる</button>
    </div>
    <div class="muted small">retire しても成績とピック履歴は保持されます（選別実験のデータセットとして蓄積）。</div>
  `);

  modal.querySelector('#btn-close-model').addEventListener('click', closeModal);
  modal.querySelector('#btn-edit-model').addEventListener('click', () => openModelForm(m));
  modal.querySelector('#btn-add-pick').addEventListener('click', () => openPickForm(m, null));
  modal.querySelectorAll('[data-pick]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = state.modelPicks.find((x) => x.id === el.dataset.pick);
      if (p) openPickForm(m, p);
    });
  });

  const retire = modal.querySelector('#btn-retire-model');
  if (retire) {
    retire.addEventListener('click', () => {
      const reason = prompt(`「${m.name}」を retire します。理由・学びをメモしてください（成績履歴は保持されます）`);
      if (reason === null) return;
      m.status = 'retired';
      m.retiredAt = nowIso();
      m.retiredReason = reason.trim() || null;
      touch(m);
      save();
      closeModal();
      rerender();
      toast('retire しました（履歴は保持されます）');
    });
  }
  const revive = modal.querySelector('#btn-revive-model');
  if (revive) {
    revive.addEventListener('click', () => {
      m.status = 'active';
      m.retiredAt = null;
      m.retiredReason = null;
      touch(m);
      save();
      closeModal();
      rerender();
      toast('稼働に戻しました');
    });
  }
}

function pickRow(p) {
  const perf = pickPerformance(state, p);
  const bench = BENCHMARKS[pickBenchmarkKey(p.ticker)];
  let perfHtml;
  if (perf.status === 'no_entry') {
    perfHtml = '<span class="warn-text">エントリー価格未設定（タップして入力）</span>';
  } else if (perf.status === 'no_price') {
    perfHtml = '<span class="warn-text">現在価格が未取得（タップして入力）</span>';
  } else {
    perfHtml = `絶対 <b class="${relClass(perf.absReturn)}">${fmtSignedPct(perf.absReturn)}</b>
      ／ 相対 <b class="${relClass(perf.relReturn)}">${fmtSignedPct(perf.relReturn)}</b>
      ${perf.relReturn === null ? `<span class="muted">（${esc(bench)} の記録が無い期間 — 欠損）</span>` : `<span class="muted">vs ${esc(bench)}</span>`}`;
  }
  return `
    <button class="item" data-pick="${esc(p.id)}">
      <span class="item-main">
        <span class="item-title">
          <span class="tag">${esc(p.ticker)}</span>
          <span class="muted small">${esc(p.date || '')} ・ weight ${p.weight}</span>
          ${p.exitDate ? `<span class="chip soft">クローズ ${esc(p.exitDate)}</span>` : ''}
        </span>
        <span class="item-sub small">
          エントリー ${p.entryPrice ?? '未設定'} → ${p.exitDate ? `イグジット ${p.exitPrice ?? '-'}` : `現在 ${effectivePickPrice(state, p)?.value ?? '-'}`}
        </span>
        <span class="item-sub small">${perfHtml}</span>
        ${p.rationale ? `<span class="item-sub muted small">${esc(p.rationale.slice(0, 90))}</span>` : ''}
      </span>
      <span class="chev">›</span>
    </button>`;
}

// ---- モデル編集 ----

function openModelForm(m) {
  const isNew = !m;
  const d = m || { name: '', logicPrompt: '', origin: '', cadence: 'monthly', status: 'active' };
  const modal = openModal(isNew ? 'モデルを追加' : 'モデルを編集', `
    <form id="model-form">
      <label>モデル名<input name="name" value="${esc(d.name)}" required placeholder="例: 配当クオリティ型"></label>
      <label>選定ロジック（logicPrompt — AI にそのまま渡されます）
        <textarea name="logicPrompt" rows="6" required>${esc(d.logicPrompt || '')}</textarea>
      </label>
      <label>出典・由来（origin — 参考論文・アイデアの出所）
        <input name="origin" value="${esc(d.origin || '')}" placeholder="論文名・記事・着想メモ">
      </label>
      <div class="muted small">実行サイクルは月次固定です。logicPrompt には「公開情報のみ」「断定的推奨をしない」の制約を含めることを推奨します。</div>
      <div class="btn-row">
        <button type="submit" class="btn primary">${isNew ? '追加' : '保存'}</button>
        ${isNew ? '' : '<button type="button" class="btn danger" id="btn-del-model">削除</button>'}
      </div>
    </form>
  `);

  modal.querySelector('#model-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const target = isNew ? newEntity({ cadence: 'monthly', status: 'active', retiredAt: null, retiredReason: null }) : m;
    Object.assign(target, {
      name: String(fd.get('name')).trim(),
      logicPrompt: String(fd.get('logicPrompt') || ''),
      origin: String(fd.get('origin') || ''),
    });
    touch(target);
    if (isNew) state.models.push(target);
    save();
    closeModal();
    rerender();
    toast(isNew ? 'モデルを追加しました' : '保存しました');
  });

  const del = modal.querySelector('#btn-del-model');
  if (del) {
    del.addEventListener('click', () => {
      const picks = modelPicksFor(state, m.id).length;
      if (!confirm(`「${m.name}」を完全に削除しますか？${picks ? `\nピック履歴 ${picks} 件も削除されます。` : ''}\n（成績を残したい場合は削除ではなく retire を使ってください）`)) return;
      state.models = state.models.filter((x) => x.id !== m.id);
      state.modelPicks = state.modelPicks.filter((x) => x.modelId !== m.id);
      save();
      closeModal();
      rerender();
      toast('削除しました');
    });
  }
}

// ---- ピック編集 ----

function openPickForm(model, p) {
  const isNew = !p;
  const d = p || { ticker: '', date: todayStr(), entryPrice: null, weight: 1, rationale: '', exitDate: null, exitPrice: null, lastPrice: null };
  const modal = openModal(isNew ? `ピックを追加（${model.name}）` : `ピックの編集（${model.name}）`, `
    <form id="pick-form">
      <div class="grid2">
        <label>ティッカー<input name="ticker" value="${esc(d.ticker)}" required placeholder="VRT / 7203"></label>
        <label>ピック日<input name="date" type="date" value="${esc(d.date || todayStr())}" required></label>
      </div>
      <div class="grid2">
        <label>仮想エントリー価格（現地通貨）<input name="entryPrice" type="number" step="any" value="${d.entryPrice ?? ''}" placeholder="未設定可"></label>
        <label>weight<input name="weight" type="number" step="any" min="0" value="${d.weight ?? 1}"></label>
      </div>
      <label>根拠（rationale）<textarea name="rationale" rows="2">${esc(d.rationale || '')}</textarea></label>
      <label>現在価格（手動更新。日本株はこちらで）<input name="lastPriceValue" type="number" step="any" value="${d.lastPrice?.value ?? ''}" placeholder="一括更新でも自動取得（米国株）"></label>
      <fieldset><legend>クローズ（仮想イグジット）</legend>
        <div class="grid2">
          <label>イグジット日<input name="exitDate" type="date" value="${esc(d.exitDate || '')}"></label>
          <label>イグジット価格<input name="exitPrice" type="number" step="any" value="${d.exitPrice ?? ''}"></label>
        </div>
      </fieldset>
      <div class="btn-row">
        <button type="submit" class="btn primary">${isNew ? '追加' : '保存'}</button>
        ${isNew ? '' : '<button type="button" class="btn danger" id="btn-del-pick">削除</button>'}
      </div>
    </form>
  `);

  modal.querySelector('#pick-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ticker = String(fd.get('ticker')).trim().toUpperCase();

    const hit = findRestricted(state, ticker);
    if (hit) {
      const ok = confirm(`⚠ ${ticker} は制限リストに登録されています。\n理由: ${hit.reason || '-'}\n\n仮想ピックとして記録しますか？`);
      if (!ok) return;
    }

    const lastPriceValue = Number(fd.get('lastPriceValue'));
    let lastPrice = p?.lastPrice ?? null;
    if (lastPriceValue > 0 && lastPriceValue !== (p?.lastPrice?.value ?? null)) {
      lastPrice = { value: lastPriceValue, asOf: todayStr(), source: 'manual' };
    } else if (!(lastPriceValue > 0)) {
      lastPrice = null;
    }

    const target = isNew ? newEntity({ modelId: model.id }) : p;
    Object.assign(target, {
      ticker,
      date: fd.get('date') || todayStr(),
      entryPrice: Number(fd.get('entryPrice')) > 0 ? Number(fd.get('entryPrice')) : null,
      weight: Number(fd.get('weight')) > 0 ? Number(fd.get('weight')) : 1,
      rationale: String(fd.get('rationale') || ''),
      exitDate: fd.get('exitDate') || null,
      exitPrice: Number(fd.get('exitPrice')) > 0 ? Number(fd.get('exitPrice')) : null,
      lastPrice,
    });
    touch(target);
    if (isNew) state.modelPicks.push(target);
    save();
    closeModal();
    rerender();
    toast(isNew ? 'ピックを追加しました' : '保存しました');
    openModelDetail(model);
  });

  const del = modal.querySelector('#btn-del-pick');
  if (del) {
    del.addEventListener('click', () => {
      if (!confirm(`${p.ticker} のピックを削除しますか？（成績履歴が失われます。クローズで残す方が推奨です）`)) return;
      state.modelPicks = state.modelPicks.filter((x) => x.id !== p.id);
      save();
      closeModal();
      rerender();
      toast('削除しました');
      openModelDetail(model);
    });
  }
}
