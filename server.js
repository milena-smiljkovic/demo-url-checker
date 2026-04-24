'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { crawl } = require('./crawler');

const app = express();
const PORT = process.env.PORT || 3000;
const REPORT_PATH = path.join(__dirname, 'staging-leak-report.md');

app.use(express.json());
app.use(express.static('public'));

function buildReport(siteUrl, pagesScanned, leaks) {
  const lines = [
    '# Staging URL Leak Report',
    '',
    `**Site:** ${siteUrl}`,
    `**Scanned:** ${new Date().toISOString()}`,
    `**Pages scanned:** ${pagesScanned}`,
    `**Total leaks:** ${leaks.length}`,
    '',
  ];
  if (leaks.length === 0) {
    lines.push('✅ No staging domain leaks found.');
  } else {
    lines.push('| Page URL | Element | Attribute | Value |');
    lines.push('|----------|---------|-----------|-------|');
    for (const l of leaks) {
      lines.push(`| ${l.page} | \`${l.element}\` | \`${l.attribute}\` | \`${l.value}\` |`);
    }
  }
  return lines.join('\n');
}

app.post('/scan', async (req, res) => {
  const { siteUrl, stagingUrl } = req.body;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  try { new URL(siteUrl); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const logs = [];
  const onProgress = info => {
    let msg;
    if      (info.type === 'log')  msg = `> ${info.msg}`;
    else if (info.type === 'page') msg = `  ${info.leaked ? '⚠️  ' + info.leaked + ' leak(s)' : '✓ clean'}`;
    else if (info.type === 'skip') msg = `  → skipped`;
    if (msg) { logs.push(msg); console.log(msg); }
  };

  try {
    const { pagesScanned, leaks } = await crawl(siteUrl, stagingUrl || null, onProgress);
    const report = buildReport(siteUrl, pagesScanned, leaks);
    fs.writeFileSync(REPORT_PATH, report, 'utf8');
    res.json({ pagesScanned, leaksFound: leaks.length, leaks, logs });
  } catch (err) {
    res.status(500).json({ error: err.message, logs });
  }
});

app.post('/scan-stream', async (req, res) => {
  const { siteUrl } = req.body;
  if (!siteUrl) return res.status(400).end();
  try { new URL(siteUrl); } catch { return res.status(400).end(); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = data => {
    try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch {}
  };

  try {
    const { pagesScanned, leaks } = await crawl(siteUrl, null, send);
    const report = buildReport(siteUrl, pagesScanned, leaks);
    fs.writeFileSync(REPORT_PATH, report, 'utf8');
    send({ type: 'done', pagesScanned, leaksFound: leaks.length, leaks });
  } catch (err) {
    send({ type: 'error', error: err.message });
  } finally {
    res.end();
  }
});

app.get('/report', (req, res) => {
  if (!fs.existsSync(REPORT_PATH)) return res.status(404).send('No report yet. Run a scan first.');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(fs.readFileSync(REPORT_PATH, 'utf8'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`Staging checker → port ${PORT}`));
