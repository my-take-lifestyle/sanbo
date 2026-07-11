#!/usr/bin/env node
// GitHub Actions 用スクリプト（設計書 §4.5）。
// 公開 RSS/Atom を取得 → config/feed-keywords.json でフィルタ → data/feed.json を生成する。
// 個人資産データ（保有・金額・比率・口座名など）は一切扱わない。ここで読むのはテーマ名/ticker等の
// 公開して困らないキーワードのみで、appState からの自動同期はしない（config は手動編集が前提）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCES_PATH = path.join(ROOT, 'config', 'feed-sources.json');
const KEYWORDS_PATH = path.join(ROOT, 'config', 'feed-keywords.json');
const OUT_DIR = path.join(ROOT, 'data');
const FEED_PATH = path.join(OUT_DIR, 'feed.json');
const SEEN_PATH = path.join(OUT_DIR, 'feed-seen.json');

const FETCH_TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_SOURCE = 30;
const MAX_OUTPUT_ITEMS = 40;
const MAX_SEEN_URLS = 800;

async function readJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'sanbo-feed-builder/1 (personal, non-commercial RSS aggregation)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// RSS 2.0 / RDF(RSS1.0) / Atom を最小限サポート
function parseFeed(xml, sourceLabel) {
  const doc = parser.parse(xml);
  const items = [];

  const rssItems = toArray(doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item);
  for (const it of rssItems) {
    items.push({
      title: stripHtml(it.title),
      link: typeof it.link === 'string' ? it.link : it.link?.['#text'] || it.link?.['@_href'] || '',
      summary: stripHtml(it.description || it['content:encoded'] || ''),
      publishedAt: it.pubDate || it['dc:date'] || null,
    });
  }

  const atomEntries = toArray(doc?.feed?.entry);
  for (const it of atomEntries) {
    const links = toArray(it.link);
    const link = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'] || links[0]?.['@_href'] || '';
    items.push({
      title: stripHtml(typeof it.title === 'string' ? it.title : it.title?.['#text']),
      link,
      summary: stripHtml(typeof it.summary === 'string' ? it.summary : it.summary?.['#text'] || it.content?.['#text'] || ''),
      publishedAt: it.updated || it.published || null,
    });
  }

  return items
    .filter((it) => it.title && it.link)
    .map((it) => ({ ...it, source: sourceLabel }))
    .slice(0, MAX_ITEMS_PER_SOURCE);
}

function normalizeDate(d) {
  const t = d ? new Date(d) : null;
  return t && !isNaN(t.getTime()) ? t.toISOString() : null;
}

function matchesKeywords(item, keywords) {
  if (keywords.length === 0) return true;
  const hay = `${item.title} ${item.summary}`.toLowerCase();
  return keywords.some((k) => hay.includes(String(k).toLowerCase()));
}

async function main() {
  const sourcesConf = await readJson(SOURCES_PATH, { sources: [] });
  const keywordsConf = await readJson(KEYWORDS_PATH, { keywords: [] });
  const seenConf = await readJson(SEEN_PATH, { urls: [] });
  const sources = sourcesConf.sources || [];
  const keywords = keywordsConf.keywords || [];
  const seenUrls = new Set(seenConf.urls || []);

  const errors = [];
  const collected = [];

  for (const src of sources) {
    try {
      const xml = await fetchText(src.url);
      const items = parseFeed(xml, src.label || src.id);
      for (const it of items) {
        collected.push({
          title: it.title,
          url: it.link,
          summary: it.summary.slice(0, 400),
          source: it.source,
          publishedAt: normalizeDate(it.publishedAt),
        });
      }
    } catch (e) {
      errors.push({ source: src.label || src.id, message: String((e && e.message) || e) });
      console.error(`[build-feed] ${src.id} failed:`, e.message || e);
    }
  }

  const filtered = collected.filter((it) => matchesKeywords(it, keywords));
  const fresh = filtered.filter((it) => !seenUrls.has(it.url));

  fresh.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  const output = fresh.slice(0, MAX_OUTPUT_ITEMS);

  for (const it of output) seenUrls.add(it.url);
  const trimmedSeen = [...seenUrls].slice(-MAX_SEEN_URLS);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    FEED_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceCount: sources.length,
        keywordCount: keywords.length,
        errors,
        items: output,
      },
      null,
      2
    ) + '\n'
  );
  await writeFile(SEEN_PATH, JSON.stringify({ urls: trimmedSeen }, null, 2) + '\n');

  console.log(`[build-feed] sources=${sources.length} collected=${collected.length} filtered=${filtered.length} new=${output.length} errors=${errors.length}`);
}

main().catch((e) => {
  console.error('[build-feed] fatal', e);
  process.exit(1);
});
