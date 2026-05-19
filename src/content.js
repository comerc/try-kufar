(function () {
  "use strict";

  const PRICE_RE = /(^|[^\d])(\d[\d\s\u00a0.,]*?)\s*(р\.|руб\.?|BYN)(?=$|[^\wа-яё])/i;
  const PRICE_GLOBAL_RE = /(^|[^\d])(\d[\d\s\u00a0.,]*?)\s*(р\.|руб\.?|BYN)(?=$|[^\wа-яё])/ig;
  const RENT_SUFFIX_RE = /^(\s*\/\s*мес\.?)/i;
  const EXISTING_USD_AFTER_RE = /^\s*\d[\d\s\u00a0.,]*\s*\$/;
  const SKIP_CONTEXT_RE = /лизинг|\/\s*м\./i;
  const BADGE_CLASS = "kufar-usd-price";
  const MIN_PRICE_BYN = 100;
  const SCAN_DEBOUNCE_MS = 250;

  let rateInfo = null;
  let scanTimer = 0;

  const formatUsd = new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  });

  init();

  async function init() {
    try {
      rateInfo = await requestUsdRate();
    } catch (error) {
      console.warn("[Kufar USD Prices] Could not load USD rate", error);
      rateInfo = null;
    }

    scanPrices();
    observePage();
  }

  async function requestUsdRate() {
    const response = await chrome.runtime.sendMessage({ type: "kufar:getUsdRate" });

    if (!response || !response.ok || !response.rateInfo) {
      console.warn("[Kufar USD Prices] Could not load USD rate", response && response.error);
      return null;
    }

    return response.rateInfo;
  }

  function scanPrices(root = document.body) {
    if (!rateInfo || !root) {
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!isPriceTextNode(node)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    nodes.forEach(addUsdBadge);
    scanPriceElements(root);
  }

  function isPriceTextNode(node) {
    const text = node.nodeValue || "";
    const parent = node.parentElement;

    if (!parent || !PRICE_RE.test(text)) {
      return false;
    }

    if (parent.closest(`.${BADGE_CLASS}, script, style, noscript, textarea, input, select, [contenteditable="true"]`)) {
      return false;
    }

    if (/[€]|договор/i.test(text) || shouldSkipContext(parent, text)) {
      return false;
    }

    return extractBynMatch(text) !== null;
  }

  function addUsdBadge(node) {
    const text = node.nodeValue || "";
    const match = extractBynMatch(text);

    if (match === null) {
      return;
    }

    const owner = isolatePriceOwner(node, match);
    const byn = match.amount;
    isolateRentSuffix(owner);
    const badge = getOrCreateBadge(owner);
    syncBadgeSpacing(badge);
    placeBadgeBeforeRentSuffix(badge);
    const source = `${byn}:${rateInfo.rate}:${rateInfo.date}`;

    if (badge.dataset.source === source) {
      return;
    }

    badge.textContent = `≈ ${formatUsd.format(byn / rateInfo.rate)}`;
    badge.title = `Курс НБ РБ: 1 USD = ${rateInfo.rate} BYN, ${formatDate(rateInfo.date)}`;
    badge.dataset.source = source;
    badge.dataset.rateState = rateInfo.stale ? "stale" : "fresh";
  }

  function scanPriceElements(root) {
    const candidates = root.querySelectorAll([
      "[class*='price' i]",
      "[data-testid*='price' i]",
      "[aria-label*='цен' i]",
      "[aria-label*='price' i]"
    ].join(","));

    for (const element of candidates) {
      addUsdBadgeToElement(element);
    }
  }

  function addUsdBadgeToElement(element) {
    if (!isPriceElement(element)) {
      return;
    }

    const text = element.textContent || "";
    const match = extractBynMatch(text);
    if (match === null) {
      return;
    }

    isolateRentSuffix(element);
    const badge = getOrCreateBadge(element);
    syncBadgeSpacing(badge);
    placeBadgeBeforeRentSuffix(badge);
    const source = `${match.amount}:${rateInfo.rate}:${rateInfo.date}`;

    if (badge.dataset.source === source) {
      return;
    }

    badge.textContent = `≈ ${formatUsd.format(match.amount / rateInfo.rate)}`;
    badge.title = `Курс НБ РБ: 1 USD = ${rateInfo.rate} BYN, ${formatDate(rateInfo.date)}`;
    badge.dataset.source = source;
    badge.dataset.rateState = rateInfo.stale ? "stale" : "fresh";
  }

  function isPriceElement(element) {
    if (
      element.closest(`.${BADGE_CLASS}, script, style, noscript, textarea, input, select, [contenteditable="true"]`) ||
      element.querySelector(`.${BADGE_CLASS}`)
    ) {
      return false;
    }

    const text = normalizeWhitespace(element.textContent || "");

    if (!text || text.length > 140 || /[€]|договор/i.test(text) || shouldSkipContext(element, text)) {
      return false;
    }

    return extractBynMatch(text) !== null;
  }

  function getOrCreateBadge(owner) {
    const existing = findExistingBadge(owner);
    if (existing) {
      markPriceRow(existing);
      return existing;
    }

    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;

    if (owner.childNodes.length === 1 && owner.parentElement && isInlinePriceWrapper(owner)) {
      owner.insertAdjacentElement("afterend", badge);
    } else {
      owner.append(" ", badge);
    }

    markPriceRow(badge);

    return badge;
  }

  function syncBadgeSpacing(badge) {
    const previous = badge.previousElementSibling;

    if (!previous) {
      badge.classList.remove("kufar-usd-price--no-left-gap");
      return;
    }

    const previousMarginRight = Number.parseFloat(getComputedStyle(previous).marginRight);

    if (previousMarginRight > 0) {
      badge.classList.add("kufar-usd-price--no-left-gap");
    } else {
      badge.classList.remove("kufar-usd-price--no-left-gap");
    }
  }

  function shouldSkipContext(element, text) {
    if (SKIP_CONTEXT_RE.test(text)) {
      return true;
    }

    const context = normalizeWhitespace((element.closest("a, button, [role='button']") || element).textContent || "");

    return SKIP_CONTEXT_RE.test(context);
  }

  function markPriceRow(badge) {
    const parent = getPriceRowContainer(badge) || badge.parentElement;

    if (!parent) {
      return;
    }

    parent.classList.add("kufar-usd-price-row");
  }

  function isolateRentSuffix(priceOwner) {
    const container = getPriceRowContainer(priceOwner);

    if (!container || container.querySelector(".kufar-usd-rent-suffix")) {
      return null;
    }

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement && node.parentElement.closest(`.${BADGE_CLASS}, .kufar-usd-rent-suffix`)) {
          return NodeFilter.FILTER_REJECT;
        }

        return RENT_SUFFIX_RE.test(node.nodeValue || "")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });

    const node = walker.nextNode();
    if (!node) {
      return;
    }

    const match = (node.nodeValue || "").match(RENT_SUFFIX_RE);
    if (!match) {
      return;
    }

    const range = document.createRange();
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[1].length);

    const wrapper = document.createElement("span");
    wrapper.className = "kufar-usd-rent-suffix";
    range.surroundContents(wrapper);
    copyTextStyle(priceOwner, wrapper);

    container.classList.add("kufar-usd-price-row--rent");

    if (wrapper.parentElement !== container) {
      container.insertBefore(wrapper, getInsertionReference(priceOwner));
    }

    return wrapper;
  }

  function copyTextStyle(source, target) {
    const style = getComputedStyle(source);

    target.style.color = style.color;
    target.style.fontFamily = style.fontFamily;
    target.style.fontSize = style.fontSize;
    target.style.fontWeight = style.fontWeight;
    target.style.lineHeight = style.lineHeight;
    target.style.letterSpacing = style.letterSpacing;
  }

  function placeBadgeBeforeRentSuffix(badge) {
    const row = getPriceRowContainer(badge) || badge.parentElement;
    const suffix = row && row.querySelector(".kufar-usd-rent-suffix");

    if (!row || !suffix || (badge.compareDocumentPosition(suffix) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      return;
    }

    row.insertBefore(badge, suffix);
  }

  function getPriceRowContainer(priceOwner) {
    const parent = priceOwner.parentElement;

    if (!parent) {
      return null;
    }

    return isInlinePriceWrapper(parent) && parent.parentElement
      ? parent.parentElement
      : parent;
  }

  function getInsertionReference(priceOwner) {
    let current = priceOwner;

    while (current.parentElement && isInlinePriceWrapper(current.parentElement)) {
      current = current.parentElement;
    }

    return current.nextSibling;
  }

  function isInlinePriceWrapper(element) {
    return ["A", "B", "EM", "I", "SPAN", "STRONG"].includes(element.tagName);
  }

  function findExistingBadge(owner) {
    const next = owner.nextElementSibling;
    if (next && next.classList.contains(BADGE_CLASS)) {
      return next;
    }

    for (const child of owner.children) {
      if (child.classList.contains(BADGE_CLASS)) {
        return child;
      }
    }

    return null;
  }

  function extractBynMatch(text) {
    for (const match of text.matchAll(PRICE_GLOBAL_RE)) {
      const normalized = match[2]
        .replace(/[\s\u00a0]/g, "")
        .replace(",", ".");
      const amount = Number(normalized);

      if (!Number.isFinite(amount) || amount < MIN_PRICE_BYN) {
        continue;
      }

      const startIndex = match.index + match[1].length;
      const endIndex = match.index + match[0].length;

      if (hasExistingUsdAfter(text, endIndex)) {
        continue;
      }

      return { amount, startIndex, endIndex };
    }

    return null;
  }

  function isolatePriceOwner(node, match) {
    const parent = node.parentElement;
    const rawText = node.nodeValue || "";
    const normalizedBefore = normalizeWhitespace(rawText.slice(0, match.startIndex));
    const normalizedAfter = normalizeWhitespace(rawText.slice(match.endIndex));

    if (!normalizedBefore && !normalizedAfter) {
      return parent;
    }

    const range = document.createRange();
    range.setStart(node, match.startIndex);
    range.setEnd(node, match.endIndex);

    const wrapper = document.createElement("span");
    wrapper.className = "kufar-usd-price-source";
    range.surroundContents(wrapper);

    return wrapper;
  }

  function hasExistingUsdAfter(text, endIndex) {
    return EXISTING_USD_AFTER_RE.test(text.slice(endIndex));
  }

  function observePage() {
    const observer = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => isOwnMutation(mutation))) {
        return;
      }

      clearTimeout(scanTimer);
      scanTimer = window.setTimeout(() => scanPrices(), SCAN_DEBOUNCE_MS);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function isOwnMutation(mutation) {
    const target = mutation.target.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target.parentElement;

    return Boolean(target && target.closest(`.${BADGE_CLASS}`));
  }

  function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleDateString("ru-RU");
  }

})();
