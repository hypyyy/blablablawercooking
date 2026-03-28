/**
 * eBay UK scraper API — Playwright headless Chromium
 */

import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const PORT = process.env.PORT || 3001;
const app = express();
app.use(cors());

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-blink-features=AutomationControlled",
];

async function scrapeEbay(url) {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-GB",
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    const page = await context.newPage();
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
    await browser.close();
  }
}

// Global queue — serialise all scrapes to avoid RAM exhaustion
let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

app.get("/api/ebay-search", async (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.status(400).json({ error: '"q" is required' });

  const enc = encodeURIComponent(q);
  const activeUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${enc}&_sacat=0&_ipg=60`;
  const soldUrl   = `https://www.ebay.co.uk/sch/i.html?_nkw=${enc}&_sacat=0&LH_Sold=1&LH_Complete=1&_ipg=60`;

  try {
    console.log(`[eBay] Searching: "${q}"`);
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
