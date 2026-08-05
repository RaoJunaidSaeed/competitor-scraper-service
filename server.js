/**
 * server.js
 * Wraps the Playwright discovery/scraping logic as an HTTP service so
 * n8n Cloud (which cannot run Playwright directly) can call it via a
 * normal HTTP Request node.
 *
 * Endpoints:
 *   GET  /health                — simple uptime check, use this for Render's health check
 *   POST /discover              — onboarding tool: scan a page for candidate price selectors
 *   POST /scrape                — production tool: extract price using a known selector (Tier 2),
 *                                   falls back to returning a screenshot for Vision (Tier 3) if the
 *                                   selector fails or isn't provided
 *
 * Auth: every request (except /health) must include header
 *   x-api-key: <SERVICE_API_KEY>
 * matching the SERVICE_API_KEY environment variable set in Render — this stops
 * random internet traffic from using your deployed browser as a public scraper.
 */

const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SERVICE_API_KEY = process.env.SERVICE_API_KEY;

function requireApiKey(req, res, next) {
  if (!SERVICE_API_KEY) {
    return res.status(500).json({ success: false, error: 'Server misconfigured: SERVICE_API_KEY not set' });
  }
  const key = req.header('x-api-key');
  if (key !== SERVICE_API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid or missing x-api-key header' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok', uptime_seconds: process.uptime() });
});

async function launchStealthPage() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(18000);
  return { browser, context, page };
}

async function dismissConsent(page) {
  const consentSelectors = [
    'text=/i understand/i', 'text=/accept all/i', 'text=/accept cookies/i',
    'text=/^accept$/i', 'text=/got it/i', 'text=/i agree/i',
    '#onetrust-accept-btn-handler'
  ];
  for (const sel of consentSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ timeout: 1500, force: true });
        await page.waitForTimeout(400);
        break;
      }
    } catch (_) { /* try next */ }
  }
}

app.post('/discover', requireApiKey, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ success: false, error: 'Missing "url" in request body' });

  let result = { success: false };
  let browserHandle;

  try {
    const { browser, page } = await launchStealthPage();
    browserHandle = browser;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    try {
      await page.waitForLoadState('networkidle', { timeout: 6000 });
    } catch (_) { /* some sites never go fully idle — proceed anyway */ }

    try {
      await page.waitForFunction(
        () => /(\$|€|£)\s?\d/.test(document.body.innerText || ''),
        { timeout: 8000 }
      );
    } catch (_) { /* proceed — likelyBlocked check below will flag it */ }

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const bodyTextLength = bodyText.trim().length;

    const blockIndicators = ['access denied', 'request blocked', 'are you a human', 'captcha', 'unusual traffic'];
    const lowerBody = bodyText.toLowerCase();
    const likelyBlocked = blockIndicators.some(phrase => lowerBody.includes(phrase)) || bodyTextLength < 200;

    await dismissConsent(page);

    const structuredData = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const found = [];
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent);
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            const graph = item['@graph'] || [item];
            for (const node of graph) {
              const type = node['@type'];
              if (type === 'Product' || type === 'Offer' || type === 'AggregateOffer') {
                const offer = node.offers || node;
                found.push({
                  name: node.name || null,
                  price: offer.price || offer.lowPrice || null,
                  currency: offer.priceCurrency || null,
                  type
                });
              }
            }
          }
        } catch (_) { /* not valid JSON-LD, skip */ }
      }
      return found;
    });

    const patternMatches = await page.evaluate(() => {
      const priceRegex = /(\$|€|£|USD|EUR|GBP)\s?\d{1,3}(,\d{3})*(\.\d{1,2})?/;

      function buildSelector(el) {
        const stableClass = Array.from(el.classList || [])
          .find(c =>
            !/^css-[a-z0-9]{5,8}$/i.test(c) &&
            !/-sc-[a-z0-9]{5,10}(-\d+)?$/i.test(c) &&
            !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(c)
          );
        if (stableClass) return `${el.tagName.toLowerCase()}.${CSS.escape(stableClass)}`;

        let path = [];
        let node = el;
        while (node && node !== document.body) {
          if (node.id && /^[a-zA-Z][\w-]*$/.test(node.id)) {
            path.unshift(`#${CSS.escape(node.id)}`);
            break;
          }
          const parent = node.parentElement;
          if (!parent) break;
          const idx = Array.from(parent.children).indexOf(node) + 1;
          path.unshift(`${node.tagName.toLowerCase()}:nth-child(${idx})`);
          node = parent;
        }
        return path.join(' > ');
      }

      function nearestHeading(el) {
        let node = el;
        for (let i = 0; i < 6 && node; i++) {
          let sib = node.previousElementSibling;
          while (sib) {
            if (/^H[1-6]$/.test(sib.tagName) && sib.innerText.trim()) return sib.innerText.trim();
            sib = sib.previousElementSibling;
          }
          node = node.parentElement;
        }
        return null;
      }

      const matches = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parentTag = node.parentElement && node.parentElement.tagName;
          if (parentTag === 'SCRIPT' || parentTag === 'STYLE') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let textNode;
      const seen = new Set();
      while ((textNode = walker.nextNode())) {
        const text = textNode.textContent.trim();
        if (!text || !priceRegex.test(text)) continue;
        const el = textNode.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);

        const sel = buildSelector(el);
        let matchCount = null;
        try {
          matchCount = document.querySelectorAll(sel).length;
        } catch (_) {
          matchCount = null;
        }
        matches.push({
          text: text.slice(0, 80),
          selector: sel,
          selectorMatchCount: matchCount,
          nearestHeading: nearestHeading(el),
          tag: el.tagName.toLowerCase()
        });
      }
      return matches;
    });

    const screenshotBuffer = await page.screenshot({ fullPage: true, timeout: 45000 });
    const screenshotBase64 = screenshotBuffer.toString('base64');

    result = {
      success: true,
      url,
      likelyBlocked,
      bodyTextLength,
      structuredData,
      patternMatches,
      screenshotBase64,
      note: likelyBlocked
        ? 'Page appears blocked or never fully rendered. Screenshot returned — inspect manually.'
        : structuredData.length > 0
          ? 'Structured data (JSON-LD) found — prefer these values, they are more stable than CSS selectors.'
          : 'No structured data found — review patternMatches and pick a selector, or use the /scrape Vision fallback.'
    };

  } catch (err) {
    result = { success: false, error: err.message };
  } finally {
    if (browserHandle) await browserHandle.close();
  }

  res.json(result);
});

app.post('/scrape', requireApiKey, async (req, res) => {
  const { url, selector } = req.body || {};
  if (!url) return res.status(400).json({ success: false, error: 'Missing "url" in request body' });

  let result = { success: false };
  let browserHandle;

  try {
    const { browser, page } = await launchStealthPage();
    browserHandle = browser;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await dismissConsent(page);

    let priceText = null;
    let selectorFound = false;

    if (selector) {
      try {
        await page.waitForSelector(selector, { timeout: 20000 });
        priceText = await page.locator(selector).first().innerText();
        selectorFound = true;
      } catch (_) {
        // selector failed — fall through, screenshot still gets taken for Vision fallback
      }
    }

    const screenshotBuffer = await page.screenshot({ fullPage: true, timeout: 45000 });
    const screenshotBase64 = screenshotBuffer.toString('base64');

    result = {
      success: true,
      url,
      selectorFound,
      priceText,
      screenshotBase64,
      needsVisionFallback: !selectorFound
    };

  } catch (err) {
    result = { success: false, error: err.message };
  } finally {
    if (browserHandle) await browserHandle.close();
  }

  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Competitor scraper service listening on port ${PORT}`);
});