// 自動収集フィード（設計書 §4.5。Phase 3）
// GitHub Actions が生成した data/feed.json を fetch するだけ。appState には入れない
// （ワンタップで IntelCard 化されるまで永続化しない）。オフライン/未配信でも黙って失敗する。
let cache = null; // { fetchedAt, data }
const CACHE_MS = 10 * 60 * 1000;

export async function loadAutoFeed(force = false) {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.data;
  try {
    const res = await fetch('./data/feed.json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    cache = { fetchedAt: Date.now(), data };
    return data;
  } catch (e) {
    // 未配信（Actions未設定）・オフラインとも区別せず静かに諦める（原則2: 機能停止しない）
    cache = { fetchedAt: Date.now(), data: null };
    return null;
  }
}
