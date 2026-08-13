const { chromium } = require('playwright');
const fs = require('node:fs/promises');

const PRODUCT_SELECTOR = '[data-qa-locator="product-item"]';

/**
 * Converts:
 * "313 sold" -> 313
 * "1.2K sold" -> 1200
 * "(87)" -> 87
 * "Rs. 249" -> 249
 */
function parseCompactNumber(value) {
  if (!value) return null;

  const match = value
    .replace(/,/g, '')
    .trim()
    .match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);

  if (!match) return null;

  const multipliers = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
  };

  const multiplier = match[2]
    ? multipliers[match[2].toLowerCase()]
    : 1;

  return Math.round(Number(match[1]) * multiplier);
}

/**
 * Scrolls to the bottom until the product count and page height stop changing.
 */
async function loadLazyProducts(page, maxScrolls = 30) {
  let previousCount = -1;
  let previousHeight = -1;
  let stableRounds = 0;

  for (let i = 0; i < maxScrolls; i += 1) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    await page.waitForTimeout(900);

    const count = await page.locator(PRODUCT_SELECTOR).count();
    const height = await page.evaluate(() => document.body.scrollHeight);

    if (count === previousCount && height === previousHeight) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    if (stableRounds >= 2) {
      break;
    }

    previousCount = count;
    previousHeight = height;
  }
}

/**
 * Creates a signature so the scraper does not loop over the same page.
 */
async function getPageSignature(page) {
  return page.locator(PRODUCT_SELECTOR).evaluateAll((cards) => {
    const first = cards[0]?.getAttribute('data-item-id') || '';
    const last = cards.at(-1)?.getAttribute('data-item-id') || '';

    return `${cards.length}|${first}|${last}`;
  });
}

/**
 * Extracts products from the currently loaded search page.
 */
async function extractProductsFromCurrentPage(page, pageNumber) {
  const products = await page.locator(PRODUCT_SELECTOR).evaluateAll(
    (cards, currentPageNumber) => {
      const cleanText = (element) =>
        element?.textContent?.replace(/\s+/g, ' ').trim() || null;

      const text = (card, selector) =>
        cleanText(card.querySelector(selector));

      const absoluteUrl = (value) => {
        if (!value) return null;

        try {
          return new URL(value, window.location.href).href;
        } catch {
          return value;
        }
      };

      return cards.map((card, index) => {
        const titleLink = card.querySelector(
          '.RfADt a[title], .RfADt a'
        );

        const image = card.querySelector(
          'img[type="product"], img'
        );

        const priceText = text(
          card,
          '.aBrP0 .ooOxS, .ooOxS'
        );

        const discountText = text(
          card,
          '.WNoq3 .IcOsH, .IcOsH'
        );

        const soldText = text(
          card,
          '._6uN7R ._1cEkb span:first-child, ._1cEkb span:first-child'
        );

        const reviewsText = text(
          card,
          '.mdmmT .qzqFw, .qzqFw'
        );

        const trackingText = card.getAttribute('data-utlogmap');

        let tracking = null;

        if (trackingText) {
          try {
            tracking = JSON.parse(trackingText);
          } catch {
            tracking = trackingText;
          }
        }

        return {
          page: currentPageNumber,
          positionOnPage: index + 1,

          itemId: card.getAttribute('data-item-id'),
          sku: card.getAttribute('data-sku-simple'),
          listNumber: card.getAttribute('data-listno'),

          title:
            titleLink?.getAttribute('title') ||
            cleanText(titleLink),

          productUrl: absoluteUrl(
            titleLink?.getAttribute('href')
          ),

          imageUrl: absoluteUrl(
            image?.getAttribute('src') ||
              image?.getAttribute('data-src') ||
              image?.getAttribute('data-ks-lazyload')
          ),

          imageAlt: image?.getAttribute('alt') || null,

          priceText,
          currency: priceText?.includes('Rs') ? 'PKR' : null,

          discountText,

          coinsText: text(
            card,
            '.WNoq3 .ic-dynamic-badge-text'
          ),

          soldText,
          reviewsText,

          location: text(
            card,
            '._6uN7R .oa6ri, .oa6ri'
          ),

          tracking,
        };
      });
    },
    pageNumber
  );

  return products.map((product) => ({
    ...product,

    price: parseCompactNumber(product.priceText),

    discountPercent: parseCompactNumber(
      product.discountText
    ),

    soldCount: parseCompactNumber(product.soldText),

    reviewCount: parseCompactNumber(
      product.reviewsText
    ),
  }));
}

/**
 * Finds the enabled pagination Next button.
 */
async function findNextButton(page) {
  const selectors = [
    'li.ant-pagination-next:not(.ant-pagination-disabled) button',
    'li.ant-pagination-next:not(.ant-pagination-disabled) a',
    'button[aria-label="Next Page"]:not([disabled])',
    'a[aria-label="Next Page"]',
    '[data-qa-locator="page-next"]:not([disabled])',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const exists = (await locator.count()) > 0;

    if (
      exists &&
      (await locator.isVisible().catch(() => false)) &&
      (await locator.isEnabled().catch(() => false))
    ) {
      return locator;
    }
  }

  return null;
}

/**
 * Main reusable scraping function.
 */
async function scrapeProducts(url, options = {}) {
  const {
    // 0 means continue until there is no Next button.
    maxPages = 0,

    headless = true,

    outputFile = null,
  } = options;

  const browser = await chromium.launch({
    headless,
  });

  const context = await browser.newContext({
    locale: 'en-PK',

    viewport: {
      width: 1440,
      height: 1000,
    },
  });

  const page = await context.newPage();

  page.setDefaultTimeout(30_000);

  const productsByKey = new Map();
  const seenPageSignatures = new Set();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    await page.locator(PRODUCT_SELECTOR).first().waitFor({
      state: 'visible',
      timeout: 30_000,
    });

    let pageNumber = 1;

    while (maxPages === 0 || pageNumber <= maxPages) {
      await loadLazyProducts(page);

      const signature = await getPageSignature(page);

      if (seenPageSignatures.has(signature)) {
        console.error('Repeated page detected. Stopping.');
        break;
      }

      seenPageSignatures.add(signature);

      const pageProducts =
        await extractProductsFromCurrentPage(
          page,
          pageNumber
        );

      for (const product of pageProducts) {
        const uniqueKey =
          product.itemId ||
          product.productUrl ||
          `${pageNumber}-${product.positionOnPage}`;

        productsByKey.set(uniqueKey, product);
      }

      console.error(
        `Page ${pageNumber}: ` +
          `${pageProducts.length} cards, ` +
          `${productsByKey.size} unique products total`
      );

      if (maxPages > 0 && pageNumber >= maxPages) {
        break;
      }

      const nextButton = await findNextButton(page);

      if (!nextButton) {
        console.error('No Next button found. Finished.');
        break;
      }

      const previousSignature = signature;

      await nextButton.scrollIntoViewIfNeeded();
      await nextButton.click();

      // Wait until the product list changes.
      await page
        .waitForFunction(
          ({ selector, previous }) => {
            const cards = [
              ...document.querySelectorAll(selector),
            ];

            const first =
              cards[0]?.getAttribute('data-item-id') || '';

            const last =
              cards.at(-1)?.getAttribute('data-item-id') ||
              '';

            const current =
              `${cards.length}|${first}|${last}`;

            return current !== previous;
          },
          {
            selector: PRODUCT_SELECTOR,
            previous: previousSignature,
          },
          {
            timeout: 20_000,
          }
        )
        .catch(() => {
          // Some sites update without changing the signature immediately.
        });

      await page
        .locator(PRODUCT_SELECTOR)
        .first()
        .waitFor({ state: 'visible' });

      pageNumber += 1;
    }

    const result = {
      sourceUrl: url,
      scrapedAt: new Date().toISOString(),
      totalProducts: productsByKey.size,
      products: [...productsByKey.values()],
    };

    if (outputFile) {
      await fs.writeFile(
        outputFile,
        JSON.stringify(result, null, 2),
        'utf8'
      );
    }

    return result;
  } finally {
    await browser.close();
  }
}

/**
 * CLI usage.
 */
async function main() {
  const url = process.argv[2];

  const maxPages = Number.parseInt(
    process.argv[3] || '0',
    10
  );

  const outputFile =
    process.argv[4] || 'products.json';

  if (!url) {
    console.error(
      'Usage: node scrape-products.js ' +
        '<url> [maxPages=0] [outputFile=products.json]'
    );

    process.exitCode = 1;
    return;
  }

  const result = await scrapeProducts(url, {
    maxPages: Number.isFinite(maxPages)
      ? maxPages
      : 0,

    headless: false,

    outputFile,
  });

  // Prints the complete JSON result.
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Scraping failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  scrapeProducts,
};
