/**
 * eBay UK scraper API — Playwright headless Chromium
 */

import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const PORT = process.env.PORT || 3001;
const app = express();
app.use(cors());

let browser = null;
let queue = Promise.resolve();

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    if (browser) { try { await browser.close(); } catch {} browser = null; }
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
      ],
    });
  }
  return browser;
}

async function scrapeEbay(url) {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "en-GB",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("ul.srp-results", { timeout: 10000 }).catch(() => {});

    return await page.evaluate(() => {
      const results = [];
      document.querySelectorAll("ul.srp-results > li").forEach((el) => {
        const title = el.querySelector(".s-card__title span")?.textContent?.replace("New listing", "")?.trim();
        if (!title || title === "Shop on eBay") return;
        const priceText = el.querySelector(".s-card__price")?.textContent || "";
        const priceMatch = priceText.replace(/,/g, "").match(/£([\d]+\.?\d*)/);
        const price = priceMatch ? parseFloat(priceMatch[1]) : null;
        if (!price || price <= 0) return;
        const condition = el.querySelector(".s-card__subtitle span")?.textContent?.trim() || "Unknown";
        const attrsText = el.querySelector("[class*=attribute-row]")?.textContent?.toLowerCase() || "";
        const bidsText = el.querySelector("[class*=bid]")?.textContent?.trim() || "";
        let type = "BIN";
        if (/\d+\s*bid/i.test(bidsText)) type = "Auction";
        else if (attrsText.includes("best offer")) type = "Best Offer";
        const bidsMatch = bidsText.match(/(\d+)/);
        const shipping = el.querySelector("[class*=shipping],[class*=delivery]")?.textContent?.trim() || "Free delivery";
        const location = el.querySelector("[class*=location]")?.textContent?.replace("From ", "")?.trim() || null;
        const date = el.querySelector("[class*=ended],[class*=sold]")?.textContent?.trim() || null;
        results.push({ title, price, condition, type, bids: bidsMatch ? parseInt(bidsMatch[1]) : 0, shipping, location, date });
      });
      return results;
    });
  } finally {
    try { await context.close(); } catch {}
  }
}

// Run all scrapes sequentially to avoid browser crashes under concurrency
function enqueue(fn) {
  const result = queue.then(fn).catch((err) => { browser = null; throw err; });
  queue = result.catch(() => {});
  return result;
}

app.get("/api/ebay-search", async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: '"q" is required' });

  const enc = encodeURIComponent(q);
  const activeUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${enc}&_sacat=0&_ipg=60`;
  const soldUrl   = `https://www.ebay.co.uk/sch/i.html?_nkw=${enc}&_sacat=0&LH_Sold=1&LH_Complete=1&_ipg=60`;

  try {
    console.log(`[eBay] Searching: "${q}"`);
    // Scrape sequentially via queue to keep browser stable
    const active = await enqueue(() => scrapeEbay(activeUrl));
    const sold   = await enqueue(() => scrapeEbay(soldUrl));
    console.log(`[eBay] Done: ${active.length} active, ${sold.length} sold`);
    res.json({ keyword: q, active, sold, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[eBay] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`eBay scraper → http://localhost:${PORT}`));

process.on("SIGINT", async () => { if (browser) await browser.close(); process.exit(); });
