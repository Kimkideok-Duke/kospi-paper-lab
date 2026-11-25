import { percentage, rate, weight } from "./engine.mjs";

const feeds = [
  ["미 연준", "federalreserve.gov", "https://www.federalreserve.gov/feeds/press_monetary.xml"],
  ["미 연준", "federalreserve.gov", "https://www.federalreserve.gov/feeds/speeches.xml"],
  ["미 노동통계국", "bls.gov", "https://www.bls.gov/feed/bls_latest.rss"],
  ["미 경제분석국", "bea.gov", "https://apps.bea.gov/rss/rss.xml"],
  ["CNBC", "cnbc.com", "https://www.cnbc.com/id/100003114/device/rss/rss.html"],
  ["CNBC", "cnbc.com", "https://www.cnbc.com/id/19854910/device/rss/rss.html"],
  ["NPR", "npr.org", "https://feeds.npr.org/1006/rss.xml"],
];

const topics = {
  market: "미국 증시",
  rates: "금리·물가",
  trade: "관세·수출정책",
  chips: "반도체·AI",
  autos: "자동차·배터리",
  energy: "원유·에너지",
};
const indicators = {
  market: /\b(?:wall street|s&p\s*500|dow(?: jones)?|nasdaq|u\.?s\.? (?:stocks|markets)|american stocks)\b/i,
  rates: /\b(?:federal reserve|the fed|fed chair|fomc|fed(?:eral)? funds|inflation|cpi|pce|treasury yields?|interest rates?|rate cuts?)\b/i,
  trade: /\b(?:tariffs?|trade (?:deal|war|truce)|export (?:curbs?|controls?|restrictions?)|import dut(?:y|ies))\b/i,
  chips: /\b(?:nvidia|advanced micro devices|amd|micron|semiconductor\w*|chipmakers?|ai (?:chips?|spending|infrastructure)|memory chips?)\b/i,
  autos: /\b(?:automakers?|auto industry|electric vehicles?|tesla|general motors|ford motor|battery (?:makers?|demand))\b/i,
  energy: /\b(?:crude(?: oil)?|brent|wti|oil (?:prices?|futures)|u\.?s\.? energy companies)\b/i,
};
const positive = /\b(?:ris(?:es?|ing)|rose|gains?|climbs?|rall(?:y|ies|ied)|jumps?|surges?|rebounds?|beats? (?:forecasts?|expectations|estimates)|above (?:forecasts?|estimates|expectations)|raises? (?:its )?(?:outlook|guidance)|demand (?:surges?|accelerates?))\b/i;
const negative = /\b(?:falls?|fell|drop(?:s|ped)?|slid(?:e|es)?|sinks?|plunges?|tumbles?|slumps?|sell-?off|rout|miss(?:es)? (?:forecasts?|expectations|estimates)|below (?:forecasts?|estimates|expectations)|cuts? (?:its )?(?:outlook|guidance)|demand (?:slows?|weakens?))\b/i;
const directions = {
  rates: [
    /\b(?:fed (?:cuts?|lowers?) (?:interest )?rates?|(?:cut|lower)(?:s|ed)? the target range|inflation (?:cools?|slows?|eases?|below expectations)|rate cut (?:odds|bets) (?:rise|jump)|treasury yields? (?:fall|drop|slide))\b/i,
    /\b(?:fed (?:raises?|hikes?) (?:interest )?rates?|(?:rais|increas)(?:es|ed) the target range|inflation (?:accelerates?|heats up|above expectations|hotter than expected)|higher for longer|rate cut (?:odds|bets) (?:fall|drop)|treasury yields? (?:rise|jump|surge))\b/i,
  ],
  trade: [
    /\b(?:rolls? back|lifts?|removes?|eases?|pauses?|slas(?:h|hes)|reduces?|lowers?)\b.{0,32}\b(?:tariffs?|export (?:controls?|curbs?|restrictions?))\b|\b(?:trade (?:deal|truce) (?:reached|signed)|(?:strike|sign)s? (?:a )?trade deal)\b/i,
    /\b(?:imposes?|raises?|hikes?|expands?|tightens?|announces? new)\b.{0,32}\b(?:tariffs?|export (?:controls?|curbs?|restrictions?))\b|\btrade war escalates?\b/i,
  ],
};
const symbolThemes = {
  chips: /반도체|파운드리|메모리|하이닉스|^삼성전자|엔비디아|필라델피아|HBM|팹리스|AI인프라|AI서버/i,
  autos: /자동차|모빌리티|전기차|이차전지|2차전지|배터리|^현대차|^현대모비스|^기아$|^LG에너지솔루션|^삼성SDI/i,
  energy: /원유|정유|가스|에너지|WTI|브렌트|^S-Oil/i,
};

function xmlText(value) {
  const entities = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return (value ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, key) => {
      const number = key.startsWith("#x") ? parseInt(key.slice(2), 16) : key.startsWith("#") ? Number(key.slice(1)) : NaN;
      if (Number.isInteger(number) && number > 0 && number <= 0x10ffff) return String.fromCodePoint(number);
      return entities[key.toLowerCase()] ?? original;
    }).replace(/\s+/g, " ").trim();
}

function value(item, tag) {
  return xmlText(item.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i"))?.[1]);
}

function newsUrl(text, host) {
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password
      || !(url.hostname === host || url.hostname.endsWith("." + host))) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function relevantTopics(title, source) {
  return Object.keys(indicators).filter(key => {
    if (key === "rates" && /\b(?:european central bank|bank of japan|bank of england|ecb|boj)\b/i.test(title)
      && !/\b(?:the fed|federal reserve|u\.?s\.?)\b/i.test(title)) return false;
    return indicators[key].test(title) || (key === "rates" && source === "미 연준"
      && /discount rate|policy statement|monetary policy/i.test(title));
  });
}

export function articleSignals(title, description, source, matches) {
  const signals = {};
  for (const topic of matches) {
    const [up, down] = directions[topic] ?? [positive, negative];
    const officialRates = topic === "rates" && source === "미 연준";
    const text = officialRates
      ? title + " " + description : title.split(/\b(?:as|while|after|but|despite|amid)\b|[:;]|[—–]/i)[0];
    if (!officialRates && !indicators[topic].test(text)) continue;
    if (topic === "trade" && !/\b(?:u\.?s\.?|united states|trump|white house|washington|american)\b/i.test(text)) continue;
    if (/\b(?:could|might|may|what if)\b/i.test(text)) continue;
    if (up.test(text) !== down.test(text)) signals[topic] = up.test(text) ? 1 : -1;
  }
  return signals;
}

async function readFeed([source, host, url], from, until) {
  const response = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error("News feed unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let xml = "";
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      length += chunk.byteLength;
      if (length > 500_000) {
        await reader.cancel();
        throw new Error("News feed too large");
      }
      xml += decoder.decode(chunk, { stream: true });
    }
    xml += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!/<rss\b/i.test(xml)) throw new Error("Unexpected RSS response");
  return Array.from(xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)).flatMap(([, item]) => {
    const title = value(item, "title").slice(0, 200);
    const time = Date.parse(value(item, "pubDate"));
    const link = newsUrl(value(item, "link"), host);
    if (!title || !link || !Number.isFinite(time) || time < from || time >= until
      || /<metadata:sponsored>\s*true\s*<\/metadata:sponsored>/i.test(item)) return [];
    const matched = relevantTopics(title, source);
    if (!matched.length && !/^(미 연준|미 노동통계국|미 경제분석국)$/.test(source)) return [];
    const description = source === "미 연준" ? value(item, "description").slice(0, 500) : "";
    return [{ title, time, link, source, matched, signals: articleSignals(title, description, source, matched) }];
  });
}

function uniqueArticles(articles) {
  const seen = new Set();
  const candidates = articles.sort((a, b) => b.time - a.time);
  const distinct = [];
  for (const item of candidates) {
    const link = new URL(item.link);
    const identity = link.hostname.replace(/^www\./, "") + link.pathname;
    const words = new Set(item.title.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    if (seen.has(identity) || distinct.some(other => words.size >= 4 && other.words.size >= 4
      && [...words].filter(word => other.words.has(word)).length / new Set([...words, ...other.words]).size >= 0.72)) continue;
    distinct.push({ ...item, words });
    seen.add(identity);
  }
  return distinct;
}

export async function collectOpeningNews(day, slot, window = null) {
  const until = window?.until ?? Date.parse(slot.date + "T09:00:00+09:00");
  const close = window?.previousClose ?? Date.parse(day.previousBusinessDay?.integrated?.regularMarket?.endTime);
  const fallbackWindow = !Number.isFinite(close) || close >= until;
  const from = fallbackWindow ? until - 24 * 3600_000 : close;
  const results = await Promise.allSettled(feeds.map(feed => readFeed(feed, from, until)));
  const sources = [...new Set(results.flatMap((result, index) => result.status === "fulfilled" ? [feeds[index][0]] : []))];
  const available = results.filter(result => result.status === "fulfilled").length;
  const distinct = uniqueArticles(results.flatMap(result => result.status === "fulfilled" ? result.value : []));
  const totals = {};
  for (const key of Object.keys(topics)) {
    const bySource = new Map();
    for (const item of distinct) {
      if (item.signals[key]) bySource.set(item.source, (bySource.get(item.source) ?? 0) + item.signals[key]);
    }
    totals[key] = sources.length < 2 ? 0 : [...bySource.values()].reduce((sum, score) => sum + Math.sign(score), 0);
  }
  const broad = totals.market + totals.rates + totals.trade;
  const stance = broad <= -1 ? "cautious" : broad >= 1 ? "positive" : "neutral";
  const highlights = distinct.filter(item => Object.keys(item.signals).length);
  const shown = [...highlights, ...distinct.filter(item => !Object.keys(item.signals).length)].slice(0, 5)
    .map(({ title, source, link, time, matched }) => ({ title, source, link, time, themes: matched.map(key => topics[key]) }));
  const topicSummary = Object.entries(totals).filter(([, score]) => score)
    .map(([key, score]) => topics[key] + (score > 0 ? " 우호" : " 부담")).join(" · ");
  const message = sources.length < 2 ? "미국 뉴스 출처 부족으로 시세 기준을 적용했습니다."
    : !distinct.length ? "수집 범위에 해당하는 미국 시장 뉴스가 없습니다."
    : topicSummary ? topicSummary : "뚜렷하게 같은 방향을 가리키는 신호가 없어 시세 기준을 적용했습니다.";
  return { from, until, fallbackWindow, count: distinct.length, available, feedCount: feeds.length,
    sources, stance, totals, message, items: shown };
}

export function openingSignal(news, stock) {
  if (!news) return { score: 0, caution: false, reason: null, relevant: false };
  const usThemes = { chips: /^(?:NVDA|AMD|INTC|AVGO|MU|TSM|ASML|SMH|SOXX|SOXL|SOXS)$/,
    autos: /^(?:TSLA|GM|F|RIVN|NIO|XPEV|LI)$/,
    energy: /^(?:XOM|CVX|COP|SLB|XLE|USO)$/ };
  const themes = Object.keys(symbolThemes).filter(key => symbolThemes[key].test(stock.name)
    || (stock.marketCountry === "US" && usThemes[key].test(stock.symbol)));
  const inverse = /인버스|inverse|곱버스/i.test(stock.name);
  const sign = inverse ? -1 : 1;
  const sector = themes.reduce((sum, key) => sum + news.totals[key], 0) * sign;
  const impact = themes.filter(key => news.totals[key])
    .map(key => topics[key] + (news.totals[key] * sign > 0 ? " 우호" : " 부담"));
  const broadFund = stock.type === "ETF" && (/코스피|KOSPI|^(?:KODEX|TIGER|RISE|ACE|SOL|HANARO) 200(?:\s|$)/i.test(stock.name)
    || (stock.marketCountry === "US" && /^(?:SPY|IVV|VOO|QQQ|DIA|VTI)$/.test(stock.symbol)));
  const cautiousMarket = !inverse && news.stance === "cautious";
  const positiveMarket = !inverse && broadFund && news.stance === "positive";
  if (cautiousMarket || positiveMarket) impact.push(cautiousMarket ? "시장 부담" : "시장 우호");
  return { score: weight(sector, -2, 2) * 0.45 + (positiveMarket ? 0.25 : 0),
    caution: cautiousMarket || sector < 0, reason: impact.length ? "미국 뉴스(" + impact.join("·") + ")" : null,
    relevant: sector > 0 || positiveMarket };
}

export function openingExitReason(news, position, price, previousClose) {
  const signal = openingSignal(news, position);
  const change = rate(price, previousClose);
  if (!signal.caution || change === null || change > -1.75) return null;
  return signal.reason + " 및 전일 기준가 대비 " + percentage(change) + " 하락으로 위험 축소";
}
