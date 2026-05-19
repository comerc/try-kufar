"use strict";

const RATE_URL = "https://api.nbrb.by/exrates/rates/USD?parammode=2";
const CACHE_KEY = "kufarUsdRate";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "kufar:getUsdRate") {
    return false;
  }

  getUsdRate()
    .then((rateInfo) => sendResponse({ ok: true, rateInfo }))
    .catch((error) => {
      console.warn("[Kufar USD Prices] Could not load USD rate", error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function getUsdRate() {
  const cached = await readCache();
  const now = Date.now();

  if (cached && cached.rate && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const response = await fetch(RATE_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`NBRB responded with ${response.status}`);
    }

    const data = await response.json();
    const scale = Number(data.Cur_Scale) || 1;
    const rate = Number(data.Cur_OfficialRate) / scale;

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("NBRB returned an invalid USD rate");
    }

    const fresh = {
      rate,
      date: data.Date || new Date().toISOString(),
      fetchedAt: now,
      stale: false
    };

    await writeCache(fresh);
    return fresh;
  } catch (error) {
    if (cached && cached.rate) {
      return { ...cached, stale: true };
    }

    throw error;
  }
}

function readCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CACHE_KEY, (result) => {
      resolve(result[CACHE_KEY] || null);
    });
  });
}

function writeCache(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CACHE_KEY]: value }, resolve);
  });
}
