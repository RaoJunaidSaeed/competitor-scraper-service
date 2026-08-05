#!/usr/bin/env node
/**
 * discover-pricing.js
 * Onboarding tool — use this ONCE per new competitor to find candidate
 * price elements and their CSS selectors, before you have a
 * Selector_CSS_XPath on file. Output is a ranked list for a human to
 * review and pick from (per Section 4's manual onboarding step).
 *
 * Usage:
 *   node discover-pricing.js --url "https://example.com/pricing" --outdir "./screenshots"
 *
 * Prints a JSON report to stdout with two sections:
 *   - structuredData: prices found via JSON-LD (most reliable, use these if present)
 *   - patternMatches: prices found via regex scan, each with an auto-generated
 *     CSS selector and nearby heading text for context
 */

const { chromium } = require('playwright');
const fs = require('fs');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) continue;
    const key = token.replace(/^--/, '');
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const { url, outdir } = parseArgs();

  if (!url) {
    console.log(JSON.stringify({ success: false, error: 'Missing --url' }));
    process.exit(0);
  }

  const outputDir = outdir || './screenshots';
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });

  let result = { success: false };

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 }
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(18000);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // SPA-heavy sites (React/Vue) often show a spinner right after domcontentloaded
    // fires. Wait for network activity to settle, then double-check real text
    // exists on the page before proceeding — a blank/spinner page has almost no text.
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch (_) { /* some sites never go fully idle (polling, analytics) — proceed anyway */ }

    // Instead of a fixed delay, actively wait until price-like text shows up
    // anywhere on the page (or we give up after 8s). This adapts to both
    // fast pages (stops early) and slow-hydrating ones (waits longer than
    // a fixed timer would), without needing per-site tuning.
    try {
      await page.waitForFunction(
        () => /(\$|€|£)\s?\d/.test(document.body.innerText || ''),
        { timeout: 8000 }
      );
    } catch (_) { /* no price-like text appeared in time — proceed, likelyBlocked check below will flag it */ }

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const bodyTextLength = bodyText.trim().length;

    // Detect obvious hard blocks (WAF/CDN rejection pages) so this is visible
    // in the result immediately, instead of silently returning empty matches.
    const blockIndicators = ['access denied', 'request blocked', 'are you a human', 'captcha', 'unusual traffic'];
    const lowerBody = bodyText.toLowerCase();
    const likelyBlocked = blockIndicators.some(phrase => lowerBody.includes(phrase)) || bodyTextLength < 200;

    // Dismiss cookie banners so they don't hide/shift pricing content
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

    // --- Strategy 1: JSON-LD structured data (schema.org Product/Offer) ---
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

    // --- Strategy 2: generic price-pattern scan with selector generation ---
    const patternMatches = await page.evaluate(() => {
      // Matches $99, $99.99, €49, £120, 1,299.00 etc. Adjust for other currencies as needed.
      const priceRegex = /(\$|€|£|USD|EUR|GBP)\s?\d{1,3}(,\d{3})*(\.\d{1,2})?/;

      function buildSelector(el) {
        // Prefer a stable-looking class (skip obvious hash/UUID-style classes), else fall back to nth-child path
        const stableClass = Array.from(el.classList || [])
          .find(c =>
            !/^css-[a-z0-9]{5,8}$/i.test(c) &&           // emotion/styled-components (css-xxxxx)
            !/-sc-[a-z0-9]{5,10}(-\d+)?$/i.test(c) &&    // styled-components v5 (ComponentName-sc-hash-N)
            !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(c)          // embedded UUIDs
          );
        if (stableClass) return `${el.tagName.toLowerCase()}.${stableClass}`;

        // Fallback: build a full nth-child path from this element up to <body>
        // (or up to the nearest ancestor with an id, which is shorter and just
        // as unique). A shallow 2-3 level path isn't enough on pages with deep,
        // repetitive component nesting (e.g. HubSpot's unstyled span wrappers) —
        // it produces the same "selector" for many different elements.
        let path = [];
        let node = el;
        while (node && node !== document.body) {
          if (node.id) {
            path.unshift(`#${node.id}`);
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
          // Skip script/style content — it's never visible pricing text, just
          // framework hydration payloads (e.g. Next.js) or CSS that happen to
          // contain $-like patterns.
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

        matches.push({
          text: text.slice(0, 80),
          selector: buildSelector(el),
          selectorMatchCount: document.querySelectorAll(buildSelector(el)).length,
          nearestHeading: nearestHeading(el),
          tag: el.tagName.toLowerCase()
        });
      }
      return matches;
    });

    const screenshotPath = `${outputDir}/discovery-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const screenshotBase64 = fs.readFileSync(screenshotPath).toString('base64');

    result = {
      success: true,
      url,
      likelyBlocked,
      bodyTextLength,
      structuredData,
      patternMatches,
      screenshotPath,
      screenshotBase64,
      note: likelyBlocked
        ? 'Page appears blocked or never fully rendered (very little text found, or a block-page phrase detected). Screenshot saved — check it manually. This site likely needs a different tracking approach (see below).'
        : structuredData.length > 0
          ? 'Structured data (JSON-LD) found — prefer these values, they are more stable than CSS selectors.'
          : 'No structured data found — review patternMatches and pick the selector for the price you want to track.'
    };

  } catch (err) {
    result = { success: false, error: err.message };
  } finally {
    await browser.close();
  }

  const { debug } = parseArgs();
  if (debug && result.screenshotBase64) {
    const { screenshotBase64, ...printable } = result;
    console.log(JSON.stringify({
      ...printable,
      screenshotBase64: `[${screenshotBase64.length} chars, omitted — use without --debug to get the full value]`
    }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(err => {
  console.log(JSON.stringify({ success: false, error: `Fatal: ${err.message}` }));
  process.exit(0);
});