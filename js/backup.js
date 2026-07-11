// 自動バックアップ（設計書 Phase3 item 3）
// File System Access API 対応ブラウザ: ユーザーが一度指定したファイルへワンタップ上書き。
// FileSystemFileHandle は localStorage に保存できないため IndexedDB に1件だけ保持する。
// 非対応ブラウザ（iOS Safari 等）ではこのモジュールは何もできないと報告し、呼び出し側が
// 従来のダウンロード方式（settings.js の JSON エクスポート）にフォールバックする。
const DB_NAME = 'sanbo-backup';
const STORE = 'handles';
const KEY = 'backupFile';

export function isFileSystemAccessSupported() {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSavedHandle() {
  if (!isFileSystemAccessSupported()) return null;
  try {
    return await idbGet(KEY);
  } catch (e) {
    return null;
  }
}

async function ensurePermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

// ファイル保存先をユーザーに選ばせ、以後再利用するために保存する
export async function chooseBackupFile(suggestedName) {
  const handle = await window.showSaveFilePicker({
    suggestedName,
    types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
  });
  await idbSet(KEY, handle);
  return handle;
}

export async function forgetBackupFile() {
  await idbDelete(KEY);
}

// 保存済みハンドルへ appState 全量を上書き保存。権限が失効していれば再確認を求める。
export async function writeBackup(handle, jsonText) {
  const ok = await ensurePermission(handle);
  if (!ok) throw new Error('書き込み権限が許可されませんでした');
  const writable = await handle.createWritable();
  await writable.write(jsonText);
  await writable.close();
}
