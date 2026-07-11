// インテル受信箱 — URL/メモ投入・AI 連携・トリアージ・自動収集（設計書 §3, §4.5）
import { state, save, newEntity, touch, todayStr } from '../state.js';
import { untriagedIntel } from '../derive.js';
import { esc, toast, openModal, closeModal, copyText, sentimentDot, SENTIMENT_LABEL } from '../ui.js';
import { buildContextPack } from '../prompts.js';
import { extractPasteback, applyBriefing, applyThemeReview, saveRawFallback } from '../parse.js';
import { loadAutoFeed } from '../feed.js';
import { applyPicksFromText } from './models.js';
import { render as rerender } from '../app.js';

const SOURCE_LABEL = { url: 'URL', memo: 'メモ', work_insight: '業務知見', ai_briefing: 'AI' };

let showArchived = false;

export function render(root) {
  const inbox = untriagedIntel(state).sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
  const triaged = state.intel
    .filter((c) => !c.archived && (c.themeIds || []).length > 0)
    .sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
  const archived = state.intel
    .filter((c) => c.archived)
    .sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));

  root.innerHTML = `
    <section class="card ai-panel">
      <h2>AI 連携（週次ブリーフィング）</h2>
      <p class="muted small">1. コンテキストパックをコピーして AI チャットに貼る → 2. 回答の全文を下に貼り戻す → 3. 取り込む。<br>
      パックに含む資産情報は${state.settings.ai.includeAbsoluteAmounts ? '金額あり' : '比率のみ'}（設定画面で変更可）。</p>
      <button class="btn primary block" id="btn-pack">📋 コンテキストパックを生成してコピー</button>
      <textarea id="paste-back" rows="4" placeholder="AI の回答（付録C の JSON ブロックを含む全文）をここに貼り付け"></textarea>
      <button class="btn block" id="btn-apply">回答を取り込む</button>
      <p class="muted small">週次ブリーフィングとテーマレビュー（テーマ詳細から生成）のどちらの回答もここで取り込めます。
      JSON が読めない場合も、全文を1枚のインテルとして保存します（データは失われません）。</p>
    </section>

    <section class="card">
      <h2>クイック投入</h2>
      <form id="url-form" class="btn-row wrap">
        <input name="url" type="url" placeholder="https://…（記事・レポートの URL）" required>
        <button type="submit" class="btn">URL 追加</button>
      </form>
      <form id="memo-form">
        <textarea name="memo" rows="2" placeholder="メモ（例: 展示会で液冷の引き合いが急増していると聞いた）" required></textarea>
        <div class="btn-row">
          <label class="check"><input type="checkbox" name="workInsight"> 業務知見（work_insight）</label>
          <button type="submit" class="btn">メモ追加</button>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="row-between">
        <h2>自動収集</h2>
        <button class="btn small" id="btn-autofeed-refresh">🔄</button>
      </div>
      <p class="muted small">GitHub Actions が公開 RSS から拾ったものです（設計書 §4.5）。気になるものだけ「取り込む」で受信箱へ。appState には保存前は入りません。</p>
      <div id="autofeed-list"><div class="empty">読み込み中…</div></div>
    </section>

    <section class="card">
      <div class="row-between">
        <h2>未トリアージ <span class="badge">${inbox.length}</span></h2>
      </div>
      ${inbox.length ? `<div class="list">${inbox.map(cardRow).join('')}</div>`
        : '<div class="empty">受信箱は空です（Inbox Zero 🎉）</div>'}
    </section>

    <section class="card">
      <h2>トリアージ済み</h2>
      ${triaged.length ? `<div class="list">${triaged.slice(0, 30).map(cardRow).join('')}</div>`
        : '<div class="empty">まだありません。</div>'}
      <button class="btn small block" id="btn-toggle-archived">${showArchived ? 'アーカイブを隠す' : `アーカイブを表示（${archived.length}）`}</button>
      ${showArchived && archived.length ? `<div class="list dim">${archived.map(cardRow).join('')}</div>` : ''}
    </section>
  `;

  root.querySelector('#btn-pack').addEventListener('click', async () => {
    const pack = buildContextPack(state);
    const ok = await copyText(pack);
    if (ok) {
      toast('コンテキストパックをコピーしました。AI チャットに貼り付けてください。');
    } else {
      openModal('コンテキストパック（手動でコピー）', `<textarea rows="14" readonly>${esc(pack)}</textarea>`);
    }
  });

  root.querySelector('#btn-apply').addEventListener('click', () => {
    const text = root.querySelector('#paste-back').value;
    if (!text.trim()) {
      toast('貼り戻すテキストが空です');
      return;
    }
    const parsed = extractPasteback(text);
    if (parsed?.type === 'briefing') {
      const r = applyBriefing(state, parsed.data);
      save();
      rerender();
      toast(`取り込み完了: インテル ${r.cardCount} 件、テーマ評価 ${r.assessCount} 件${r.blindSpot ? '、見落とし指摘 1 件' : ''}`);
    } else if (parsed?.type === 'modelPicks') {
      // モデル実行の回答はモデル側の取り込み処理へ委譲（制限リスト照合・価格補完込み）
      applyPicksFromText(text);
    } else if (parsed?.type === 'themeReview') {
      const r = applyThemeReview(state, parsed.data);
      if (r) {
        save();
        rerender();
        toast(`テーマレビューを取り込みました: 「${r.themeName}」のレビューノートとインテルに反映${r.counterEvidence ? `（反証 ${r.counterEvidence} 件）` : ''}`);
      } else {
        saveRawFallback(state, text);
        save();
        rerender();
        toast('テーマ名を解決できなかったため、全文を1枚のインテルとして保存しました');
      }
    } else {
      saveRawFallback(state, text);
      save();
      rerender();
      toast('JSON を解釈できなかったため、全文を1枚のインテルとして保存しました');
    }
  });

  root.querySelector('#url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = String(new FormData(e.target).get('url')).trim();
    state.intel.push(blankCard({ sourceType: 'url', sourceUrl: url }));
    save();
    rerender();
    toast('URL を受信箱に追加しました');
  });

  root.querySelector('#memo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.intel.push(blankCard({
      sourceType: fd.get('workInsight') ? 'work_insight' : 'memo',
      rawNote: String(fd.get('memo')).trim(),
    }));
    save();
    rerender();
    toast('メモを受信箱に追加しました');
  });

  root.querySelector('#btn-toggle-archived').addEventListener('click', () => {
    showArchived = !showArchived;
    render(root);
  });

  root.querySelectorAll('[data-intel]').forEach((el) => {
    el.addEventListener('click', () => {
      const c = state.intel.find((x) => x.id === el.dataset.intel);
      if (c) openIntelForm(c);
    });
  });

  loadAutoFeedList(root, false);
  root.querySelector('#btn-autofeed-refresh').addEventListener('click', () => loadAutoFeedList(root, true));
}

async function loadAutoFeedList(root, force) {
  const wrap = root.querySelector('#autofeed-list');
  if (!wrap) return;
  const data = await loadAutoFeed(force);
  if (!wrap.isConnected) return; // 別画面へ遷移済み
  if (!data || !data.items?.length) {
    wrap.innerHTML = '<div class="empty">新着はありません（Actions未設定、またはキーワードに合致する記事なし）</div>';
    return;
  }
  const importedUrls = new Set(state.intel.map((c) => c.sourceUrl).filter(Boolean));
  wrap.innerHTML = `<div class="list">${data.items.map((it, i) => {
    const already = importedUrls.has(it.url);
    return `
      <div class="item static ${already ? 'dim' : ''}">
        <span class="item-main">
          <span class="item-sub small muted">${esc(it.source || '')} ${it.publishedAt ? '・' + new Date(it.publishedAt).toLocaleDateString('ja-JP') : ''}</span>
          <span class="intel-line">${esc(it.title)}</span>
          ${it.summary ? `<span class="item-sub small muted">${esc(it.summary.slice(0, 120))}</span>` : ''}
        </span>
        ${already
          ? '<span class="chip soft">取込済</span>'
          : `<button class="btn small primary" data-autofeed-import="${i}">取り込む</button>`}
      </div>`;
  }).join('')}</div>`;

  wrap.querySelectorAll('[data-autofeed-import]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const it = data.items[Number(btn.dataset.autofeedImport)];
      state.intel.push(blankCard({
        sourceType: 'url',
        sourceUrl: it.url,
        title: it.title,
        rawNote: it.summary ? `[出典: ${it.source}] ${it.summary}` : `[出典: ${it.source}]`,
      }));
      save();
      rerender();
      toast('受信箱に取り込みました');
    });
  });
}

// Share Target（app.js）からも使うため公開
export function newIntelCard(fields) {
  return blankCard(fields);
}

function blankCard(fields) {
  return newEntity({
    date: todayStr(),
    sourceType: 'memo',
    sourceUrl: '',
    title: '',
    rawNote: '',
    aiSummary: '',
    implication: '',
    sentiment: 'neutral',
    themeIds: [],
    watchIds: [],
    holdingIds: [],
    actionNeeded: false,
    actionNote: '',
    archived: false,
    ...fields,
  });
}

function cardRow(c) {
  const main = c.title || c.implication || c.aiSummary || c.rawNote || c.sourceUrl || '(無題)';
  const themeNames = (c.themeIds || [])
    .map((id) => state.themes.find((t) => t.id === id)?.name)
    .filter(Boolean);
  return `
    <button class="item" data-intel="${esc(c.id)}">
      <span class="item-main">
        <span class="item-sub small">
          ${sentimentDot(c.sentiment)}
          <span class="muted">${esc(c.date || '')}</span>
          <span class="chip soft">${esc(SOURCE_LABEL[c.sourceType] || c.sourceType)}</span>
          ${c.actionNeeded ? '<span class="chip warn">要対応</span>' : ''}
        </span>
        <span class="intel-line">${esc(String(main).slice(0, 140))}</span>
        ${c.implication && main !== c.implication ? `<span class="item-sub small">💡 ${esc(c.implication.slice(0, 100))}</span>` : ''}
        ${themeNames.length ? `<span class="item-sub muted small">🧭 ${themeNames.map(esc).join('、')}</span>` : ''}
      </span>
      <span class="chev">›</span>
    </button>`;
}

function openIntelForm(c) {
  const modal = openModal('インテルの編集（トリアージ）', `
    <form id="intel-form">
      <div class="grid2">
        <label>日付<input name="date" type="date" value="${esc(c.date || todayStr())}"></label>
        <label>種別
          <select name="sourceType">
            ${Object.entries(SOURCE_LABEL).map(([k, l]) => `<option value="${k}" ${k === c.sourceType ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <label>タイトル<input name="title" value="${esc(c.title || '')}"></label>
      <label>URL<input name="sourceUrl" type="url" value="${esc(c.sourceUrl || '')}"></label>
      ${c.sourceUrl ? `<a class="small" href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">↗ 元記事を開く</a>` : ''}
      <label>メモ / 本文抜粋<textarea name="rawNote" rows="3">${esc(c.rawNote || '')}</textarea></label>
      <label>AI 要約<textarea name="aiSummary" rows="2">${esc(c.aiSummary || '')}</textarea></label>
      <label>so-what（自分の PF・テーマへの示唆）<textarea name="implication" rows="2">${esc(c.implication || '')}</textarea></label>
      <label>センチメント
        <select name="sentiment">
          ${Object.entries(SENTIMENT_LABEL).map(([k, l]) => `<option value="${k}" ${k === c.sentiment ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <fieldset><legend>テーマ（紐付けるとトリアージ完了）</legend>
        ${state.themes.length ? state.themes.map((t) => `
          <label class="check"><input type="checkbox" name="themeIds" value="${esc(t.id)}" ${(c.themeIds || []).includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>
        `).join('') : '<span class="muted small">テーマ未登録</span>'}
      </fieldset>
      <label class="check"><input type="checkbox" name="actionNeeded" ${c.actionNeeded ? 'checked' : ''}> 要対応（ダッシュボードに表示）</label>
      <label>対応メモ<input name="actionNote" value="${esc(c.actionNote || '')}"></label>
      <label class="check"><input type="checkbox" name="archived" ${c.archived ? 'checked' : ''}> アーカイブ</label>
      <div class="btn-row">
        <button type="submit" class="btn primary">保存</button>
        <button type="button" class="btn danger" id="btn-del-intel">削除</button>
      </div>
    </form>
  `);

  modal.querySelector('#intel-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    Object.assign(c, {
      date: fd.get('date') || todayStr(),
      sourceType: fd.get('sourceType'),
      title: String(fd.get('title') || ''),
      sourceUrl: String(fd.get('sourceUrl') || ''),
      rawNote: String(fd.get('rawNote') || ''),
      aiSummary: String(fd.get('aiSummary') || ''),
      implication: String(fd.get('implication') || ''),
      sentiment: fd.get('sentiment'),
      themeIds: fd.getAll('themeIds'),
      actionNeeded: !!fd.get('actionNeeded'),
      actionNote: String(fd.get('actionNote') || ''),
      archived: !!fd.get('archived'),
    });
    touch(c);
    save();
    closeModal();
    rerender();
    toast('保存しました');
  });

  modal.querySelector('#btn-del-intel').addEventListener('click', () => {
    if (!confirm('このインテルを削除しますか？')) return;
    state.intel = state.intel.filter((x) => x.id !== c.id);
    save();
    closeModal();
    rerender();
    toast('削除しました');
  });
}
