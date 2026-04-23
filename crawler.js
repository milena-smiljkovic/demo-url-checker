'use strict';

const { load } = require('cheerio');
const fs = require('fs');
const path = require('path');

const SCAN_ATTRS = ['href', 'src', 'action', 'srcset'];
const MAX_DEPTH = 4;
const DELAY_MS = 150;
const TIMEOUT_MS = 10000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadPatterns(extraDomain) {
  const file = path.join(__dirname, 'staging-domains.txt');
  const lines = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    : [];
  if (extraDomain) {
    lines.push(extraDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  return lines.map(p => new RegExp(p, 'i'));
}

function sameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch { return false; }
}

function resolveUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.href;
  } catch { return null; }
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MSP-Staging-Checker/1.0' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    return await res.text();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function scanPage($, pageUrl, patterns) {
  const leaks = [];
  $('*').each((_, el) => {
    if (el.type !== 'tag') return;
    const attrs = el.attribs || {};
    const tag = el.name || 'unknown';
    for (const [attr, val] of Object.entries(attrs)) {
      if (!val) continue;
      if (!SCAN_ATTRS.includes(attr) && !attr.startsWith('data-')) continue;
      if (patterns.some(p => p.test(val))) {
        leaks.push({ page: pageUrl, element: tag, attribute: attr, value: val });
      }
    }
  });
  return leaks;
}

function extractLinks($, pageUrl, origin) {
  const links = new Set();
  $('a').each((_, el) => {
    const href = (el.attribs || {}).href || '';
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;
    const abs = resolveUrl(href, pageUrl);
    if (abs && sameOrigin(abs, origin)) links.add(abs);
  });
  return links;
}

async function crawl(rootUrl, extraDomain, onProgress) {
  const patterns = loadPatterns(extraDomain);
  const origin = new URL(rootUrl).origin;
  const visited = new Set();
  const queue = [{ url: rootUrl, depth: 0 }];
  const allLeaks = [];
  let pagesScanned = 0;

  while (queue.length > 0) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    onProgress(`[${pagesScanned + 1}] ${url}`);
    const html = await fetchPage(url);

    if (!html) {
      onProgress(`  → skipped`);
      continue;
    }

    const $ = load(html);
    const leaks = scanPage($, url, patterns);
    pagesScanned++;

    if (leaks.length > 0) {
      onProgress(`  → ⚠️  ${leaks.length} leak(s) found`);
      allLeaks.push(...leaks);
    }

    if (depth < MAX_DEPTH) {
      for (const link of extractLinks($, url, origin)) {
        if (!visited.has(link)) queue.push({ url: link, depth: depth + 1 });
      }
    }

    await sleep(DELAY_MS);
  }

  return { pagesScanned, leaks: allLeaks };
}

module.exports = { crawl };
