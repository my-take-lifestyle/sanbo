// UI ヘルパー: エスケープ・フォーマット・トースト・モーダル・クリップボード

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function fmtJpy(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-' : '') + '¥' + Math.abs(v).toLocaleString('ja-JP');
}

export function fmtSignedJpy(n) {
  const v = Math.round(Number(n) || 0);
  return (v >= 0 ? '+' : '-') + '¥' + Math.abs(v).toLocaleString('ja-JP');
}

export function fmtPct(x, digits = 1) {
  return ((Number(x) || 0) * 100).toFixed(digits) + '%';
}

export function fmtNum(n, digits = null) {
  const v = Number(n) || 0;
  if (digits !== null) return v.toLocaleString('ja-JP', { maximumFractionDigits: digits });
  return v.toLocaleString('ja-JP', { maximumFractionDigits: 4 });
}

let toastTimer = null;
export function toast(msg, ms = 2800) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  root.textContent = msg;
  root.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => root.classList.remove('show'), ms);
}

export function openModal(title, bodyHtml) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button type="button" class="modal-close" aria-label="閉じる">×</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>`;
  root.querySelector('.modal-close').addEventListener('click', closeModal);
  root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  return root.querySelector('.modal');
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // フォールバック（クリップボード API が使えない環境）
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

export const SENTIMENT_LABEL = { positive: '好材料', negative: '懸念', neutral: '中立' };

export function sentimentDot(sentiment) {
  const cls = ['positive', 'negative', 'neutral'].includes(sentiment) ? sentiment : 'neutral';
  return `<span class="dot ${cls}" title="${esc(SENTIMENT_LABEL[cls])}"></span>`;
}
