// 設定/データ — 目標・API・AI・制限リスト・エクスポート/インポート（設計書 §2.3, §4.4, §4.5）
import {
  state, save, replaceState, clearAll, newEntity, touch, todayStr, nowIso, SCHEMA_VERSION,
} from '../state.js';
import { monthlyRecurringInvest, investableCapacity, makeSnapshot, findRestricted, latestBackupAt } from '../derive.js';
import { esc, fmtJpy, toast } from '../ui.js';
import { fetchFx } from '../api.js';
import { loadAutoFeed } from '../feed.js';
import {
  isFileSystemAccessSupported, getSavedHandle, chooseBackupFile, forgetBackupFile, writeBackup,
} from '../backup.js';
import { render as rerender } from '../app.js';

export function render(root) {
  const s = state.settings;
  const cf = state.cashflowProfile;
  const fx = state.fx.USDJPY;
  const recurring = monthlyRecurringInvest(state);
  const capacity = investableCapacity(state);
  const lastExport = s.lastExportAt
    ? `${new Date(s.lastExportAt).toLocaleDateString('ja-JP')}（${Math.floor((Date.now() - new Date(s.lastExportAt).getTime()) / 86400000)} 日前）`
    : '未実施';
  const lastAutoBackup = s.lastAutoBackupAt
    ? `${new Date(s.lastAutoBackupAt).toLocaleDateString('ja-JP')}（${Math.floor((Date.now() - new Date(s.lastAutoBackupAt).getTime()) / 86400000)} 日前 · ${s.lastAutoBackupMethod === 'file-system' ? '自動上書き' : 'ダウンロード'}）`
    : '未実施';
  const overallLast = latestBackupAt(state);
  const overallDays = overallLast ? Math.floor((Date.now() - new Date(overallLast).getTime()) / 86400000) : null;
  const fsSupported = isFileSystemAccessSupported();

  root.innerHTML = `
    <section class="card">
      <h2>目標</h2>
      <form id="targets-form">
        <div class="grid2">
          <label>待機資金の目標上限（%）
            <input name="idleMax" type="number" min="0" max="100" step="1" value="${Math.round((s.targets.idleCashRatioMax || 0.25) * 100)}">
          </label>
          <label>生活防衛資金（月数）
            <input name="emergencyMonths" type="number" min="0" step="1" value="${s.targets.emergencyMonths ?? 6}">
          </label>
        </div>
        <button type="submit" class="btn primary">保存</button>
      </form>
    </section>

    <section class="card">
      <h2>キャッシュフロー（月次の代表値）</h2>
      <form id="cf-form">
        <div class="grid2">
          <label>手取り収入（円）<input name="monthlyIncome" type="number" value="${cf.monthlyIncome ?? 0}"></label>
          <label>生活費（円）<input name="monthlyLiving" type="number" value="${cf.monthlyLiving ?? 0}"></label>
        </div>
        <div class="grid2">
          <label>住宅ローン（円）<input name="monthlyMortgage" type="number" value="${cf.monthlyMortgage ?? 0}"></label>
          <label>生活防衛資金の目標額（円）<input name="emergencyFundTargetJpy" type="number" value="${cf.emergencyFundTargetJpy ?? 0}"></label>
        </div>
        <div class="muted small">積立合計（保有の recurring から導出）: ${fmtJpy(recurring)} ／ 月次投資可能余力: <b>${fmtJpy(capacity)}</b></div>
        <button type="submit" class="btn primary">保存</button>
      </form>
    </section>

    <section class="card">
      <h2>API・為替</h2>
      <form id="api-form">
        <label>Finnhub API キー（米国株価。無料枠 60call/分）
          <input name="finnhubKey" type="password" value="${esc(s.api.finnhubKey || '')}" placeholder="未設定でも手動運用で全機能が使えます" autocomplete="off">
        </label>
        <button type="submit" class="btn primary">保存</button>
      </form>
      <div class="divider"></div>
      <div class="small">現在の為替: USD/JPY <b>${fx ? fx.value.toFixed(2) : '未取得'}</b>
        <span class="muted">${fx ? `（${esc(fx.asOf || '-')} · ${esc(fx.source || '-')}）` : ''}</span></div>
      <form id="fx-form" class="btn-row wrap">
        <input name="fxManual" type="number" step="any" placeholder="手動レート（例: 157.40）">
        <button type="submit" class="btn">手動設定</button>
        <button type="button" class="btn" id="btn-fx-fetch">今すぐ取得（Frankfurter）</button>
      </form>
      <div class="muted small">取得に失敗しても前回値のまま動作します。API へ送信されるのはティッカーのみで、資産データは外部送信しません。</div>
    </section>

    <section class="card">
      <h2>AI 連携</h2>
      <form id="ai-form">
        <label class="check">
          <input type="checkbox" name="includeAbs" ${s.ai.includeAbsoluteAmounts ? 'checked' : ''}>
          コンテキストパックに資産の絶対額を含める（オフ = 比率のみ）
        </label>
        <label>固定プロフィール（プロンプトの冒頭に入ります）
          <textarea name="profile" rows="4">${esc(s.ai.profile || '')}</textarea>
        </label>
        <button type="submit" class="btn primary">保存</button>
      </form>
    </section>

    <section class="card">
      <h2>制限リスト（取引自粛銘柄）</h2>
      <p class="muted small">自社・協業先・NDA 対象など。保有・ウォッチ追加時に照合して警告します（インサイダー取引規制への防波堤）。</p>
      ${state.restricted.length ? `<div class="list">${state.restricted.map((r) => `
        <div class="item static">
          <span class="item-main">
            <span class="item-title">${esc(r.ticker || '-')} <span class="muted">${esc(r.name || '')}</span></span>
            <span class="item-sub muted small">${esc(r.reason || '')}${r.until ? ` ・期限 ${esc(r.until)}` : ''}</span>
          </span>
          <button class="btn small danger" data-del-restricted="${esc(r.id)}">削除</button>
        </div>`).join('')}</div>` : '<div class="empty">登録なし</div>'}
      <form id="restricted-form">
        <div class="grid2">
          <label>ティッカー<input name="ticker" required placeholder="XXXX"></label>
          <label>名称<input name="name" placeholder="会社名"></label>
        </div>
        <div class="grid2">
          <label>理由<input name="reason" placeholder="業務関連/NDA" required></label>
          <label>期限（任意）<input name="until" type="date"></label>
        </div>
        <button type="submit" class="btn primary">追加</button>
      </form>
    </section>

    <section class="card">
      <h2>自動収集フィード</h2>
      <p class="muted small">GitHub Actions が日次で公開 RSS を取得し、テーマ/ticker キーワードでフィルタしたものです（設計書 §4.5）。
      取り込み判断はインテル受信箱の「自動収集」タブで行います。ここでは配信状況のみ確認できます。</p>
      <div class="small" id="feed-status">確認中…</div>
      <div class="btn-row">
        <button class="btn" id="btn-feed-refresh">🔄 今すぐ再取得を試す</button>
      </div>
      <div class="muted small">取得元・フィルタキーワードはリポジトリの <code>config/feed-sources.json</code> / <code>config/feed-keywords.json</code> を編集すると、次回の Actions 実行から反映されます。個人資産データ（金額・数量・比率）はこの経路に一切含まれません。</div>
    </section>

    <section class="card">
      <h2>データ</h2>
      <div class="small">最終バックアップ: <b>${overallLast ? `${overallDays} 日前` : '未実施'}</b></div>
      <div class="small muted">内訳 — 手動エクスポート: ${esc(lastExport)} ／ 自動バックアップ: ${esc(lastAutoBackup)}</div>
      <p class="muted small">localStorage はブラウザのサイトデータ削除で全消失します。30日以上未バックアップの場合はダッシュボードに警告が出ます（エクスポート・自動バックアップのどちらでも解消）。</p>
      <div class="btn-row wrap">
        <button class="btn primary" id="btn-export">JSON エクスポート</button>
        <label class="btn file-btn">JSON インポート<input type="file" id="file-import" accept="application/json,.json" hidden></label>
        <button class="btn" id="btn-sample">サンプルデータを読み込む</button>
        <button class="btn" id="btn-snapshot">当月スナップショットを再記録</button>
      </div>

      <div class="divider"></div>
      <h3 class="sub-h">自動バックアップ（ワンタップ上書き）</h3>
      ${fsSupported ? `
        <div class="small" id="fs-handle-status">確認中…</div>
        <div class="btn-row wrap">
          <button class="btn" id="btn-fs-choose">保存先を指定</button>
          <button class="btn primary" id="btn-fs-backup" disabled>今すぐ上書きバックアップ</button>
          <button class="btn danger" id="btn-fs-forget" disabled>保存先を解除</button>
        </div>
        <div class="muted small">対応ブラウザ（Chrome/Edge 等のデスクトップ）で一度だけファイルを指定すると、以後はワンタップで同じファイルへ上書きできます。</div>
      ` : `
        <div class="muted small">このブラウザ（主にスマホ）は自動上書き機能に非対応です。上の「JSON エクスポート」でのダウンロード方式をご利用ください。</div>
      `}

      <div class="divider"></div>
      <button class="btn danger block" id="btn-wipe">全データ消去</button>
    </section>

    <div class="muted small center">
      <a href="./docs/guide.html" target="_blank" rel="noopener">📖 取扱説明書・ビジュアルガイド</a><br>
      参謀 Phase 1-4 ・ schemaVersion ${SCHEMA_VERSION} ・ データはこの端末のブラウザ内にのみ保存されます
    </div>
  `;

  // 目標
  root.querySelector('#targets-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    s.targets.idleCashRatioMax = Math.max(0, Math.min(100, Number(fd.get('idleMax')) || 25)) / 100;
    s.targets.emergencyMonths = Number(fd.get('emergencyMonths')) || 6;
    save();
    rerender();
    toast('保存しました');
  });

  // キャッシュフロー
  root.querySelector('#cf-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    Object.assign(state.cashflowProfile, {
      monthlyIncome: Number(fd.get('monthlyIncome')) || 0,
      monthlyLiving: Number(fd.get('monthlyLiving')) || 0,
      monthlyMortgage: Number(fd.get('monthlyMortgage')) || 0,
      emergencyFundTargetJpy: Number(fd.get('emergencyFundTargetJpy')) || 0,
    });
    save();
    rerender();
    toast('保存しました');
  });

  // API キー
  root.querySelector('#api-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = String(new FormData(e.target).get('finnhubKey') || '').trim();
    s.api.finnhubKey = key || null;
    save();
    rerender();
    toast(key ? 'API キーを保存しました' : 'API キーを削除しました');
  });

  // 為替 手動/取得
  root.querySelector('#fx-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Number(new FormData(e.target).get('fxManual'));
    if (!v || v <= 0) {
      toast('有効なレートを入力してください');
      return;
    }
    state.fx.USDJPY = { value: v, asOf: todayStr(), source: 'manual' };
    save();
    rerender();
    toast(`USD/JPY を ${v} に手動設定しました`);
  });
  root.querySelector('#btn-fx-fetch').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const r = await fetchFx(state);
    e.target.disabled = false;
    if (r.ok) {
      save();
      rerender();
      toast(`為替を更新しました: ${r.value.toFixed(2)}`);
    } else {
      toast('取得に失敗しました。前回値のまま継続します。');
    }
  });

  // AI 設定
  root.querySelector('#ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    s.ai.includeAbsoluteAmounts = !!fd.get('includeAbs');
    s.ai.profile = String(fd.get('profile') || '');
    save();
    rerender();
    toast('保存しました');
  });

  // 制限リスト
  root.querySelector('#restricted-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ticker = String(fd.get('ticker')).trim().toUpperCase();
    if (findRestricted(state, ticker)) {
      toast('同じティッカーが既に登録されています');
      return;
    }
    state.restricted.push(newEntity({
      ticker,
      name: String(fd.get('name') || '').trim(),
      reason: String(fd.get('reason') || '').trim(),
      until: fd.get('until') || null,
    }));
    save();
    rerender();
    toast('制限リストに追加しました');
  });
  root.querySelectorAll('[data-del-restricted]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!confirm('制限リストから削除しますか？')) return;
      state.restricted = state.restricted.filter((r) => r.id !== b.dataset.delRestricted);
      save();
      rerender();
      toast('削除しました');
    });
  });

  // エクスポート
  root.querySelector('#btn-export').addEventListener('click', () => {
    state.settings.lastExportAt = nowIso();
    save();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sanbo-backup-${todayStr().replaceAll('-', '')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    rerender();
    toast('エクスポートしました');
  });

  // インポート
  root.querySelector('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      if (typeof obj !== 'object' || obj === null || !('schemaVersion' in obj)) {
        throw new Error('schemaVersion がありません。参謀アプリのバックアップファイルか確認してください。');
      }
      if (obj.schemaVersion > SCHEMA_VERSION) {
        if (!confirm(`このファイルは新しいスキーマ（v${obj.schemaVersion}）です。現行 v${SCHEMA_VERSION} として読み込みますか？`)) return;
      }
      if (!confirm('現在のデータを置き換えます（直前の状態は自動退避されます）。よろしいですか？')) return;
      replaceState(obj);
      toast('インポートしました。再読み込みします…');
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      alert('インポートに失敗しました: ' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  // サンプルデータ
  root.querySelector('#btn-sample').addEventListener('click', async () => {
    if (!confirm('サンプルデータを読み込みます。現在のデータは置き換えられます（直前の状態は自動退避）。よろしいですか？')) return;
    try {
      const res = await fetch('./sample-data.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      replaceState(await res.json());
      toast('サンプルデータを読み込みました。再読み込みします…');
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      alert('サンプルデータの読み込みに失敗しました: ' + err.message);
    }
  });

  // 当月スナップショット再記録
  root.querySelector('#btn-snapshot').addEventListener('click', () => {
    const ym = todayStr().slice(0, 7);
    state.snapshots = state.snapshots.filter((x) => !(x.date || '').startsWith(ym));
    state.snapshots.push(makeSnapshot(state));
    save();
    rerender();
    toast('当月スナップショットを現在値で再記録しました');
  });

  // 全消去
  root.querySelector('#btn-wipe').addEventListener('click', () => {
    if (!confirm('全データを消去します。エクスポート済みですか？')) return;
    if (!confirm('本当に消去しますか？この操作は取り消せません。')) return;
    clearAll();
    toast('消去しました。再読み込みします…');
    setTimeout(() => location.reload(), 700);
  });

  // 自動収集フィードの状況表示（設計書 §4.5）
  async function refreshFeedStatus(force) {
    const el = root.querySelector('#feed-status');
    if (!el) return;
    el.textContent = '確認中…';
    const data = await loadAutoFeed(force);
    if (!el.isConnected) return; // 画面遷移済みなら何もしない
    if (!data) {
      el.innerHTML = '<span class="muted">未配信、またはオフライン（Actions未設定でもアプリの他機能には影響しません）</span>';
    } else {
      const gen = data.generatedAt ? new Date(data.generatedAt).toLocaleString('ja-JP') : '-';
      el.innerHTML = `最終生成: <b>${esc(gen)}</b> ／ 取得元 ${data.sourceCount ?? '-'} 件 ／ 新着 ${data.items?.length ?? 0} 件${data.errors?.length ? ` <span class="warn-text">（一部取得失敗 ${data.errors.length} 件）</span>` : ''}`;
    }
  }
  refreshFeedStatus(false);
  root.querySelector('#btn-feed-refresh').addEventListener('click', () => refreshFeedStatus(true));

  // 自動バックアップ（File System Access API。非対応環境ではセクション自体を出していない）
  if (fsSupported) {
    const statusEl = root.querySelector('#fs-handle-status');
    const backupBtn = root.querySelector('#btn-fs-backup');
    const forgetBtn = root.querySelector('#btn-fs-forget');

    async function refreshHandleStatus() {
      const handle = await getSavedHandle();
      if (handle) {
        statusEl.innerHTML = `保存先: <b>${esc(handle.name)}</b>`;
        backupBtn.disabled = false;
        forgetBtn.disabled = false;
      } else {
        statusEl.innerHTML = '<span class="muted">未設定 — 「保存先を指定」でファイルを選んでください</span>';
        backupBtn.disabled = true;
        forgetBtn.disabled = true;
      }
    }
    refreshHandleStatus();

    root.querySelector('#btn-fs-choose').addEventListener('click', async () => {
      try {
        await chooseBackupFile(`sanbo-backup-${todayStr().replaceAll('-', '')}.json`);
        toast('保存先を設定しました');
        refreshHandleStatus();
      } catch (e) {
        if (e?.name !== 'AbortError') toast('保存先の指定に失敗しました: ' + e.message);
      }
    });

    backupBtn.addEventListener('click', async () => {
      const handle = await getSavedHandle();
      if (!handle) return;
      backupBtn.disabled = true;
      try {
        state.settings.lastAutoBackupAt = nowIso();
        state.settings.lastAutoBackupMethod = 'file-system';
        save();
        await writeBackup(handle, JSON.stringify(state, null, 2));
        rerender();
        toast(`「${handle.name}」に上書きバックアップしました`);
      } catch (e) {
        toast('バックアップに失敗しました: ' + e.message);
      } finally {
        backupBtn.disabled = false;
      }
    });

    forgetBtn.addEventListener('click', async () => {
      if (!confirm('保存先の指定を解除しますか？（バックアップ済みのファイル自体は残ります）')) return;
      await forgetBackupFile();
      toast('保存先の指定を解除しました');
      refreshHandleStatus();
    });
  }
}
