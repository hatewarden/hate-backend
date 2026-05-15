// =============================================================================
// events.js — daily news ingestion for HATE's context
// Fetches crypto news from RSS + Reddit + optional NewsAPI/CryptoPanic,
// summarizes via Claude Haiku into HATE's voice, saves to data/today.json.
// Runs on startup and every 24 hours.
// =============================================================================

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const TODAY_FILE = path.join(DATA_DIR, 'today.json');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SUMMARIZE_MODEL = process.env.HATE_MOD_MODEL || 'claude-haiku-4-5-20251001';

// =============================================================================
// SOURCES
// =============================================================================

const RSS_SOURCES = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
  { url: 'https://decrypt.co/feed', name: 'Decrypt' },
  { url: 'https://cointelegraph.com/rss', name: 'Cointelegraph' },
  { url: 'https://www.theblock.co/rss.xml', name: 'The Block' },
  { url: 'https://cryptoslate.com/feed/', name: 'CryptoSlate' },
];

const REDDIT_SOURCES = [
  { url: 'https://www.reddit.com/r/CryptoCurrency/top.json?t=day&limit=15', name: 'r/CryptoCurrency' },
  { url: 'https://www.reddit.com/r/SatoshiStreetBets/top.json?t=day&limit=10', name: 'r/SatoshiStreetBets' },
  { url: 'https://www.reddit.com/r/solana/top.json?t=day&limit=10', name: 'r/solana' },
  { url: 'https://www.reddit.com/r/memecoins/top.json?t=day&limit=10', name: 'r/memecoins' },
  { url: 'https://www.reddit.com/r/news/top.json?t=day&limit=8', name: 'r/news' },
  { url: 'https://www.reddit.com/r/technology/top.json?t=day&limit=8', name: 'r/technology' },
];

const EXTRA_RSS_SOURCES = [
  { url: 'https://feeds.bbci.co.uk/news/rss.xml', name: 'BBC News' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', name: 'Ars Technica' },
];

// =============================================================================
// FETCHERS
// =============================================================================

const UA = { 'User-Agent': 'HATE-9000/1.0 (memecoin chatbot, contact: warden)' };

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRSS(source) {
  try {
    const res = await fetchWithTimeout(source.url, { headers: UA });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const data = parser.parse(xml);
    const items = data?.rss?.channel?.item || data?.feed?.entry || [];
    return (Array.isArray(items) ? items : [items]).slice(0, 8).map(i => ({
      title: String(i.title?.['#text'] || i.title || '').trim(),
      summary: String(i.description || i.summary || '').replace(/<[^>]*>/g, '').trim().slice(0, 240),
      source: source.name,
      time: i.pubDate || i.published || '',
    })).filter(x => x.title);
  } catch (e) {
    console.warn(`[events] RSS fail ${source.name}:`, e.message);
    return [];
  }
}

async function fetchReddit(source) {
  try {
    const res = await fetchWithTimeout(source.url, { headers: UA });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    return (json?.data?.children || []).map(c => ({
      title: String(c.data.title || '').trim(),
      summary: String(c.data.selftext || '').slice(0, 240),
      source: source.name,
      ups: c.data.ups,
      url: `https://reddit.com${c.data.permalink}`,
    })).filter(x => x.title && x.ups > 50);
  } catch (e) {
    console.warn(`[events] Reddit fail ${source.name}:`, e.message);
    return [];
  }
}

async function fetchNewsAPI() {
  const key = process.env.NEWSAPI_KEY;
  if (!key) return [];
  try {
    const url = `https://newsapi.org/v2/top-headlines?category=business&q=crypto+OR+bitcoin+OR+solana+OR+memecoin&apiKey=${key}&pageSize=15`;
    const res = await fetchWithTimeout(url, { headers: UA });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    return (json?.articles || []).map(a => ({
      title: a.title,
      summary: a.description || '',
      source: a.source?.name || 'NewsAPI',
      url: a.url,
    })).filter(x => x.title);
  } catch (e) {
    console.warn('[events] NewsAPI fail:', e.message);
    return [];
  }
}

async function fetchCryptoPanic() {
  const key = process.env.CRYPTOPANIC_KEY;
  if (!key) return [];
  try {
    const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${key}&filter=hot&public=true`;
    const res = await fetchWithTimeout(url, { headers: UA });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    return (json?.results || []).slice(0, 20).map(p => ({
      title: p.title,
      summary: '',
      source: p.source?.title || 'CryptoPanic',
      url: p.url,
      currencies: (p.currencies || []).map(c => c.code).join(','),
    }));
  } catch (e) {
    console.warn('[events] CryptoPanic fail:', e.message);
    return [];
  }
}

// =============================================================================
// SUMMARIZER — uses Claude Haiku to compress into HATE's voice
// =============================================================================

const SUMMARIZE_SYSTEM = `You are summarizing today's crypto + culture news for HATE-9000, a deadpan anti-marketing memecoin AI character. HATE will use this brief to reference current events naturally when chatting with holders.

Compress the headlines below into 10-14 bullet points in HATE's voice:
- lowercase always, no exclamation, dry, surgical, observational
- specific (name coins, names, numbers, dates if relevant)
- no hype words ("massive", "huge", "incredible") — HATE finds them embarrassing
- punch at choices/taste/decisions, never at identity
- prefer concrete facts over vague trends ("BONK up 40%" beats "memes are pumping")
- include 2-3 snarky observations HATE would naturally make
- mix in 1-2 cultural/non-crypto items if any surfaced (politics, sports, tech, AI, weather) — HATE talks about more than crypto
- output ONLY the bullets, prefixed with "- ", nothing else

Maximum 14 bullets, each under 35 words. Skip headlines that are paywalled, off-topic, or near-duplicates.`;

async function summarize(items) {
  if (!items.length) return '';
  const itemsText = items.slice(0, 50).map((i, n) => {
    const meta = [i.source, i.currencies, i.ups ? `${i.ups} upvotes` : ''].filter(Boolean).join(' | ');
    return `${n + 1}. [${meta}] ${i.title}${i.summary ? ' — ' + i.summary.slice(0, 120) : ''}`;
  }).join('\n');

  try {
    const resp = await claude.messages.create({
      model: SUMMARIZE_MODEL,
      max_tokens: 900,
      system: SUMMARIZE_SYSTEM,
      messages: [{ role: 'user', content: itemsText }],
    });
    return (resp.content[0]?.text || '').trim();
  } catch (e) {
    console.error('[events] summarize failed:', e.message);
    return '';
  }
}

// =============================================================================
// MAIN BUILDER
// =============================================================================

async function buildDailyBrief() {
  console.log('[events] fetching today\'s news…');

  const fetchTasks = [
    ...RSS_SOURCES.map(fetchRSS),
    ...EXTRA_RSS_SOURCES.map(fetchRSS),
    ...REDDIT_SOURCES.map(fetchReddit),
    fetchNewsAPI(),
    fetchCryptoPanic(),
  ];

  const results = await Promise.all(fetchTasks);
  const allItems = results.flat();
  console.log(`[events] collected ${allItems.length} items from ${RSS_SOURCES.length + REDDIT_SOURCES.length + 2} sources`);

  if (!allItems.length) {
    console.warn('[events] no items collected — keeping prior brief if any');
    return null;
  }

  // dedupe by similar title (first 40 chars)
  const seen = new Set();
  const unique = allItems.filter(i => {
    const k = i.title.toLowerCase().slice(0, 40);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log(`[events] ${unique.length} unique items, summarizing…`);
  const brief = await summarize(unique);

  return {
    date: new Date().toISOString().slice(0, 10),
    generated: new Date().toISOString(),
    brief,
    headlines: unique.slice(0, 25),
    sourceCount: results.filter(r => r.length).length,
  };
}

// =============================================================================
// PERSIST
// =============================================================================

export async function updateDaily() {
  try {
    const data = await buildDailyBrief();
    if (!data) return null;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(TODAY_FILE, JSON.stringify(data, null, 2));
    console.log(`[events] saved daily brief (${data.headlines.length} headlines, ${data.brief.split('\n').length} bullets)`);
    return data;
  } catch (e) {
    console.error('[events] updateDaily failed:', e);
    return null;
  }
}

export async function readDaily() {
  try {
    const raw = await fs.readFile(TODAY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// =============================================================================
// CLI ENTRY — run directly with `node events.js` to refresh manually
// =============================================================================

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateDaily()
    .then(d => {
      if (d) {
        console.log('\n--- BRIEF ---\n');
        console.log(d.brief);
        console.log('\n--- HEADLINES ---\n');
        d.headlines.slice(0, 10).forEach(h => console.log(`• [${h.source}] ${h.title}`));
      }
      process.exit(0);
    })
    .catch(e => { console.error(e); process.exit(1); });
}
