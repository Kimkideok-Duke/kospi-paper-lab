import { groupTradeFills } from '/trade-groups.mjs';
import { initPatterns } from './patterns.js?v=20261126-patterns1';
import { initTradeChart } from './trade-chart.js?v=20261126-tv3';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const paths = {
  brand: '<path d="M5.5 18V12m6.5 6V6m6.5 12V9"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  list: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8m-8 4h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M9 3h6l.4 2.5 2.3 1.3 2.3-.9 3 5.2-2 1.7v2.4l2 1.8-3 5.1-2.3-.9-2.3 1.3L15 25H9l-.4-2.5-2.3-1.3-2.3.9-3-5.1 2-1.8v-2.4l-2-1.7 3-5.2 2.3.9 2.3-1.3Z" transform="translate(2 0) scale(.84)"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  eye: '<path d="M2.5 12s3.3-6 9.5-6 9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>',
  link: '<path d="M10 13.7a4 4 0 0 0 5.7 0l4-4a4 4 0 0 0-5.7-5.7l-1.8 1.8m1.9 4.5a4 4 0 0 0-5.7 0l-4 4a4 4 0 0 0 5.7 5.7l1.8-1.8"/>',
  wallet: '<path d="M20 8V6a2 2 0 0 0-2-2H6A2 2 0 0 0 4 6v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M4 8h15a2 2 0 0 1 2 2v6h-5a4 4 0 0 1 0-8m.8 4h.15"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4m-8 7h3m2 0h3m-8 3h3"/>',
  coins: '<ellipse cx="10" cy="7" rx="6" ry="3"/><path d="M4 7v4c0 1.7 2.7 3 6 3 1.2 0 2.2-.2 3-.45M4 11v4c0 1.7 2.7 3 6 3h1m5-11v3"/><circle cx="17.5" cy="16" r="3.5"/>',
  chart: '<path d="M4 19V5m0 14h16M7 15l4-4 3 2 5-6m-4 0h4v4"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 13V9m0-7h0m-2 0h4m4 4 1.5-1.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/>',
};
function icon(name) {
  return '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] ?? "") + '</svg>';
}
function refreshIcon(element) {
  element.querySelector(":scope > svg")?.remove();
  element.insertAdjacentHTML("afterbegin", icon(element.dataset.icon));
}
$$("[data-icon]").forEach(refreshIcon);
const n = new Intl.NumberFormat("ko-KR");
const fixed = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const axisFmt = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" });
const sign = value => value > 0 ? "+" : value < 0 ? "−" : "";
const money = value => n.format(value) + "원";
const dollars = value => "$" + fixed.format(value);
const signed = value => sign(value) + money(Math.abs(value));
const pct = value => sign(value) + fixed.format(Math.abs(value)) + "%";
const tone = value => value > 0 ? "gain" : value < 0 ? "loss" : "";
function stamp(value) {
  if (!value) return "—";
  const parts = Object.fromEntries(dateFmt.formatToParts(value).map(part => [part.type, part.value]));
  return parts.month + "." + parts.day + " " + parts.hour.padStart(2, "0") + ":" + parts.minute.padStart(2, "0");
}
const safe = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const defaultState = {
  initial: 10000000, limit: 5, start: "2026-11-25", end: "2026-12-25", connected: false, finished: false, batchEnabled: false,
  totals: { total: 10000000, cash: 10000000, realized: 0, pnl: 0 }, history: [], positions: [], trades: [], scans: [],
};
const demoAt = Date.parse("2026-12-10T15:00:00+09:00");
const demoPositions = [
  { name: "삼성전자", type: "주식", symbol: "005930", quantity: 23, entry: 72200, price: 74800, quoteTime: demoAt },
  { name: "KODEX 200", type: "ETF", symbol: "069500", quantity: 42, entry: 34400, price: 35950, quoteTime: demoAt },
  { name: "현대차", type: "주식", symbol: "005380", quantity: 7, entry: 225000, price: 235200, quoteTime: demoAt },
];
const sampleHistory = [10000000, 10081000, 10044500, 10170000, 10125300, 10205000, 10233700, 10203300, 10382000, 10391000,
  10335000, 10445000, 10390800, 10450300, 10428000, 10594300, 10667400];
const demo = {
  ...defaultState, latest: { at: demoAt, observed: 1814, universe: 1824, etfs: 873, index: 3291.42, indexChange: 0.84 },
  connected: true, batchEnabled: true, now: demoAt, next: demoAt + 3600000,
  history: sampleHistory.map((total, i) => ({ total, time: demoAt - (sampleHistory.length - 1 - i) * 86400000 })),
  positions: demoPositions, totals: { total: 10667400, cash: 5790700, realized: 471100, pnl: 667400 },
  trades: [
    { id: "1", time: demoAt - 8 * 86400000, name: "삼성전자", type: "주식", symbol: "005930", side: "BUY", quantity: 23, price: 72200, amount: 1660600, reason: "최근 분봉 +0.82% · 호가 간격 0.14%", realized: 0, total: 10382000, totalPnl: 382000 },
    { id: "2", time: demoAt - 3 * 86400000, name: "KODEX 200", type: "ETF", symbol: "069500", side: "BUY", quantity: 42, price: 34400, amount: 1444800, reason: "직전 시간 +0.48% · 최근 분봉 +0.30%", realized: 0, total: 10445000, totalPnl: 445000 },
    { id: "3", time: demoAt - 2 * 86400000, name: "현대차", type: "주식", symbol: "005380", side: "BUY", quantity: 7, price: 225000, amount: 1575000, reason: "최근 분봉 +0.65% · 외국인·기관 순매수", realized: 0, total: 10428000, totalPnl: 428000 },
    { id: "4", time: demoAt, name: "SK하이닉스", type: "주식", symbol: "000660", side: "SELL", quantity: 5, price: 238500, amount: 1192500, reason: "매수가 대비 +5.53% 상승으로 익절 기준 도달", realized: 62500, total: 10667400, totalPnl: 667400 },
  ],
  scans: [{ time: demoAt, status: "ok", message: "1건의 모의 거래를 기록했습니다.", tradeCount: 1 }],
};
let data = defaultState;
let selectedMarket = location.pathname.startsWith("/us") ? "US" : "KR";
const isUs = () => selectedMarket === "US";
const isDashboard = () => ["/", "/us"].includes(page);
const dashboardPath = () => isUs() ? "/us" : "/";
const tradesPath = () => isUs() ? "/us/trades" : "/trades";
const reviewsPath = () => isUs() ? "/us/reviews" : "/reviews";
let reviewMonth = null, reviewDate = null, reviewMarket = null, loadingReview = null;
const reviewCache = new Map();
let preview = false;
let loaded = false;
let failure = "";
let tickQuotes = {};
let page = "/";
let filter = "ALL";
let range = "all";
let refreshTask = null;
let announced = null;
let manualRunning = false;
let manualRequestId = null;
let health = null, modelFormVersion = null, lastAlertId = null;

async function request(path, payload) {
  if (isUs() && ["/api/state", "/api/quotes", "/api/manual-run", "/api/model"].includes(path)) path = path.replace("/api/", "/api/us/");
  const response = await fetch(path, payload === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  if (response.status === 401) { location.replace("/login"); throw new Error("로그인이 만료됐습니다."); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "서버에 연결할 수 없습니다.");
  return result;
}

function setText(selector, value) {
  $(selector).textContent = value;
}

function showNotice(message, error = false) {
  const banner = $("#notice");
  banner.hidden = !message;
  banner.textContent = message || "";
  banner.classList.toggle("error", error);
}

function current() {
  if (preview) return demo;
  if (!Object.keys(tickQuotes).length) return data;
  const positions = data.positions.map(position => {
    const quote = tickQuotes[position.symbol];
    return quote && quote.time >= position.quoteTime ? { ...position, price: quote.price, quoteTime: quote.time,
      ...(isUs() ? { priceUsd: quote.priceUsd, fxRate: quote.fxRate, valueKrw: Math.floor(quote.priceUsd * quote.fxRate * position.quantity + 1e-7) } : {}) } : position;
  });
  const marketValue = positions.reduce((sum, p) => sum + (isUs() ? p.valueKrw : p.price * p.quantity), 0);
  const total = data.totals.cash + marketValue;
  return { ...data, positions, totals: { ...data.totals, total, pnl: total - data.initial } };
}

function table(headers, rows) {
  return '<div class="table-scroll" tabindex="0"><table><thead><tr>' + headers.map(name => '<th scope="col">' + name + '</th>').join("") +
    "</tr></thead><tbody>" + rows.join("") + "</tbody></table></div>";
}

function emptyImage(image, title, description) {
  return '<div class="empty"><span class="metric-icon purple">' + icon(image) + "</span><strong>" + title + "</strong><span>" + description + "</span></div>";
}

function tradeList(trades, emptyText, grouped = true) {
  if (grouped) trades = groupTradeFills(trades);
  if (!trades.length) return emptyImage("list", emptyText, "기록된 거래의 금액과 손익이 여기에 표시됩니다.");
  return table(["체결 시각", "종목", "구분", "거래 금액", "매매 이유", "거래 실현손익", "총 평가자산"], trades.map(t => {
    const buy = t.side === "BUY";
    return '<tr class="trade-chart-row" data-trade-chart="' + safe(t.id) + '"><td>' + stamp(t.time) + (t.source === "manual" ? '<div class="small">수동 실행</div>' : t.source === "event" ? '<div class="small">뉴스·공시 반응</div>' : t.source === "monitor" ? '<div class="small">보유 감시 체결</div>' : '') +
      '</td><td class="symbol"><button type="button" class="trade-chart-link" data-trade-chart="' + safe(t.id) + '" aria-label="' + safe(t.name) + ' ' + (buy ? '매수' : '매도') + ' 차트 보기">' + safe(t.name) + ' <span aria-hidden="true">차트</span></button><span class="small">' +
      safe(t.symbol) + " · " + safe(t.type) + '</span></td><td><span class="side ' + (buy ? "buy" : "sell") + '">' +
      (buy ? "매수" : "매도") + '</span></td><td><strong>' + money(t.amount) + '</strong><div class="small">' +
      n.format(t.quantity) + (t.fills ? "주 · 평균 " : "주 × ") + (t.market === "US" ? dollars(t.priceUsd) + " · 환율 " + fixed.format(t.fxRate) + "원" : money(t.price)) +
      (t.costs ? '<div class="small">현금 정산 ' + money(t.cashAmount) + ' · 비용 ' + money(t.costs.commission + t.costs.transactionTax + t.costs.fxSpread) + '</div>' : '') + '</div></td><td class="reason">' + safe(t.reason) +
      '<div class="small">' + safe(t.strategyVersion ?? '이전 모의 방식') + '</div></td><td class="' +
      tone(t.realized) + '">' + signed(t.realized) + '</td><td class="total"><strong>' + money(t.total) +
      '</strong><span class="small ' + tone(t.totalPnl) + '">누적 ' + signed(t.totalPnl) + "</span></td></tr>" + (t.fills ?
      '<tr><td colspan="7"><details><summary>부분 체결 ' + t.fills.length + '건 · 최초 ' + stamp(t.firstFillTime) +
      ' · 상세 보기</summary>' + tradeList(t.fills, "", false) + '</details></td></tr>' : "");
  }));
}

function positionsList(positions) {
  if (!positions.length) return emptyImage("layers", "보유 종목이 없습니다", "모의 매수가 체결되면 이곳에서 확인할 수 있습니다.");
  return table(["종목", "수량", "매수가", "최근 체결가", "평가금액", "평가손익"], positions.map(p => {
    const pnl = isUs() ? p.valueKrw - p.costKrw : (p.price - p.entry) * p.quantity;
    return '<tr><td class="symbol"><strong>' + safe(p.name) + '</strong><span class="small">' + safe(p.symbol) + " · " +
      safe(p.type) + "</span></td><td>" + n.format(p.quantity) + "주</td><td>" + (isUs() ? dollars(p.entryUsd) : money(p.entry)) +
      "</td><td>" + (isUs() ? dollars(p.priceUsd) : money(p.price)) + '<div class="small">' + stamp(p.quoteTime) + "</div></td><td>" + money(isUs() ? p.valueKrw : p.quantity * p.price) +
      '</td><td class="' + tone(pnl) + '">' + signed(pnl) + " (" + pct(100 * pnl / (p.entry * p.quantity)) + ")</td></tr>";
  }));
}

function openingNewsBrief(news) {
  if (!news) return '<p class="news-summary">' + (isUs() ? "미국장 개장 회차가 완료되면 개장 전 뉴스와 판단을 표시합니다." : "09시 회차가 완료되면 확인한 미국 뉴스와 판단을 표시합니다.") + '</p>';
  const outlook = { cautious: "시장 부담", positive: "시장 우호", neutral: "중립" }[news.stance];
  const items = news.items.filter(item => item.link.startsWith("https://")).map(item => '<li><a href="' + safe(item.link) +
    '" target="_blank" rel="noopener noreferrer">' + safe(item.title) + '</a><small>' + safe(item.source) + ' · ' +
    stamp(item.time) + (item.themes.length ? ' · ' + safe(item.themes.join(' · ')) : '') + '</small></li>');
  return '<p class="news-summary"><span class="plain-badge">' + safe(outlook) + '</span> ' + safe(news.message) + '</p>' +
    '<p class="news-meta">' + stamp(news.from) + '–' + stamp(news.until) + ' · 관련 뉴스 ' + n.format(news.count) +
    '건 · 피드 ' + n.format(news.available) + '/' + n.format(news.feedCount) + (news.fallbackWindow ? ' · 24시간 기준' : '') + '</p>' +
    (items.length ? '<ul class="news-items">' + items.join('') + '</ul>' : '');
}

function render() {
  const s = current();
  const us = isUs();
  $$("[data-market]").forEach(link => {
    if (link.dataset.market === selectedMarket) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  setText("#market-scope", us ? "미국 주식 · ETF · 별도 1,000만 원" : "코스피 · ETF");
  setText("#benchmark-label", us ? "SPY (S&P 500 ETF)" : "코스피 지수");
  setText("#news-title", us ? "미국장 개장 전 뉴스" : "09시 미국 뉴스");
  setText("#news-window", us ? "직전 미국 거래일 장 마감부터 당일 정규장 개장까지" : "직전 국내 거래일 장 마감 이후부터 오전 9시까지");
  setText("#market-footer", us ? "토스증권 Open API · 미국 주식·ETF 모의투자 · 실주문 없음" : "토스증권 Open API · 코스피 · ETF · 모의투자");
  setText("#conditions-period", us ? "2026.11.25 — 2026.12.24 · 미국 현지 거래일" : "2026.11.25 — 2026.12.24 · 한국 시간");
  setText("#conditions-universe", us ? "미국 거래대금 상위 100 중 주식·ETF" : "토스증권 코스피·ETF");
  setText("#conditions-schedule", us ? "개장 +3분 첫 분석, 이후 개장 기준 10분 · 보유 감시 5초" : "09:03, 이후 10분 간격 · 보유 감시 5초");
  $("#us-session").hidden = !us;
  if (us) {
    const regular = s.session?.regularMarket;
    const hours = regular ? "정규장 " + stamp(Date.parse(regular.startTime)) + "–" + stamp(Date.parse(regular.endTime)) + " (한국 시간)"
      : s.session ? "미국 현지 " + s.session.date + " 휴장" : "미국장 운영 일정 확인 중";
    setText("#us-session", "독립 모의계좌 · " + hours + " · " + (s.fx ? "USD/KRW " + fixed.format(s.fx.rate) + "원 · " + stamp(s.fx.from) + " 기준" : "거래 시점 환율로 원화 정산") + " · 개장 +3분 / 이후 10분 간격");
  }
  $(".nav a[data-icon='grid']").setAttribute("href", dashboardPath());
  $(".nav a[data-icon='list']").setAttribute("href", tradesPath());
  $(".nav a[data-icon='calendar']").setAttribute("href", reviewsPath());
  $(".nav a[data-icon='chart']").setAttribute("href", isUs() ? "/us/patterns" : "/patterns");
  $$(".nav a").forEach(link => {
    if (link.getAttribute("href") === page) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  setText(".hero-meta div span", us ? "미국 현지 거래일" : "모의투자 기간");
  $("#manual-trades").setAttribute("href", tradesPath());
  $(".recent a[data-page]").setAttribute("href", tradesPath());
  const connected = $("#connection");
  connected.classList.toggle("connected", data.connected && !preview);
  connected.innerHTML = "<i></i> " + (preview ? "샘플 데이터" : failure ? "연결 상태 확인 불가" : !loaded ? "연결 확인 중"
    : data.connected ? "토스증권 연결됨" : "토스증권 미연결");
  $("#disconnect").hidden = !data.connected;
  $("#ip-local").hidden = !loaded || Boolean(failure) || !data.canCheckIp;
  $("#ip-hosted").hidden = !loaded || Boolean(failure) || data.canCheckIp === true;
  $("#ip-pending").hidden = loaded && !failure;
  setText("#ip-pending", failure ? "서버 연결을 확인해 주세요." : "송신 IP 조회 가능 여부를 확인 중입니다.");
  $("#connect-link").lastChild.textContent = data.connected ? "API 설정" : "API 연결";
  const manual = $("#manual-run");
  manual.hidden = !isDashboard();
  manual.disabled = manualRunning || preview || !loaded || Boolean(failure) || !data.connected || data.finished;
  manual.title = !data.connected ? "토스증권 API를 먼저 연결해 주세요."
    : preview ? "실제 계좌 화면에서 사용하세요." : "정규장 연속매매 시간에 모의 거래를 한 번 실행합니다.";
  manual.lastChild.textContent = manualRunning ? "분석 중" : "거래 실행";
  $("#manual-result").hidden = preview || !$("#manual-message").textContent;
  $("#demo-toggle").disabled = manualRunning;
  $("#demo-toggle").hidden = us;
  $("#demo-toggle").lastChild.textContent = preview ? "실제 계좌 보기" : "예시 보기";
  $("#demo-toggle").setAttribute("aria-pressed", String(preview));
  if (preview) showNotice("화면 예시용 샘플입니다. 모의 계좌의 거래와 잔액에는 영향이 없습니다.");
  else if (failure) showNotice(failure, true);
  else if (s.lastError) showNotice(s.lastError.message, true);
  else showNotice("");

  const { initial, totals, latest } = s;
  $("#equity").innerHTML = n.format(totals.total) + "<span>원</span>";
  $("#equity-pct").className = "hero-return " + tone(totals.pnl);
  setText("#equity-pct", pct(100 * totals.pnl / initial));
  setText("#equity-pnl", "시작 원금 대비 " + signed(totals.pnl));
  setText("#cash", money(totals.cash));
  $("#realized").className = tone(totals.realized);
  setText("#realized", signed(totals.realized));
  $("#count").innerHTML = s.positions.length + ' <small>/ ' + s.limit + "종목</small>";
  setText("#active-count", s.positions.length + " / " + s.limit);
  $$(".segments i").forEach((segment, index) => segment.classList.toggle("full", index < s.positions.length));
  const lastRun = s.scans.at(-1);
  setText("#batch-status", !loaded && !preview ? "확인 중" : s.batchEnabled ? "사이트 서버 배치" : "이 서버에서 미실행");
  setText("#last-run", lastRun ? stamp(lastRun.time) + (lastRun.source === "manual" ? " · 수동" : "") : "—");
  setText("#next-run", s.finished ? "기간 종료" : !s.batchEnabled ? "—" : s.connected ? (s.next ? stamp(s.next) : "예정 없음") : "연결 후 시작");
  setText("#coverage", latest ? n.format(latest.observed) + " / " + n.format(latest.universe) + "종목" : "—");
  setText("#kospi", latest?.index != null ? fixed.format(latest.index) + (latest.indexChange != null ? " (" + pct(latest.indexChange) + ")" : "") : "—");
  $("#kospi").className = tone(latest?.indexChange ?? 0);
  const missing = latest?.missing?.length && lastRun?.status === "ok";
  setText("#activity-text", s.finished ? "모의투자 기간이 종료되었습니다." : !s.batchEnabled ? "이 주소에서는 자동 배치가 실행되지 않습니다." : !s.connected ? "토스증권 API를 연결하면 자동 분석을 시작합니다."
    : lastRun ? lastRun.message + (missing ? " 일부 보조 데이터는 조회되지 않았습니다." : "") : us ? "API 연결을 공유합니다. 미국 정규장 개장 3분 뒤부터 분석합니다." : "API가 연결되었습니다. 다음 정시부터 분석합니다.");
  const quoteTime = Math.max(0, ...s.positions.map(p => p.quoteTime));
  setText("#holdings-note", quoteTime ? "최근 체결가 기준 · " + stamp(quoteTime) : "최근 체결가 기준 평가손익");
  $("#holdings-list").innerHTML = positionsList(s.positions);
  $("#opening-news").innerHTML = openingNewsBrief(s.openingNews);
  renderEvents(s.eventWatch);

  const reverse = [...s.trades].reverse();
  $("#recent-list").innerHTML = tradeList(groupTradeFills(reverse).slice(0, 5), "아직 체결된 거래가 없습니다", false);
  const filtered = reverse.filter(trade => filter === "ALL" || filter === trade.side);
  setText("#trade-count", (filter === "ALL" ? "전체" : filter === "BUY" ? "매수" : "매도") + " " + n.format(filtered.length) + "건");
  $("#trade-list").innerHTML = tradeList(filtered, "선택한 조건에 맞는 거래가 없습니다");
  const openBriefs = new Set($$("#scan-list details[open]").map(details => details.dataset.slot));
  $("#scan-list").innerHTML = s.scans.length ? [...s.scans].reverse().map(log =>
    '<div class="scan-row"><time datetime="' + new Date(log.time).toISOString() + '">' + stamp(log.time) +
    "</time><div>" + (log.source === "manual" ? '<span class="plain-badge scan-mode">수동</span>' : log.source === "event" ? '<span class="plain-badge scan-mode">뉴스·공시</span>' : log.source === "monitor" ? '<span class="plain-badge scan-mode">감시</span>' : '') + safe(log.message) +
    (log.news ? '<details class="scan-news" data-slot="' + safe(log.id) + '"' +
      (openBriefs.has(log.id) ? ' open' : '') + '><summary>' + (us ? '개장 전 미국 뉴스' : '09시 미국 뉴스') + '</summary>'
      + openingNewsBrief(log.news) + '</details>' : '') + "</div></div>").join("") :
    emptyImage("timer", "분석 기록이 없습니다", "API를 연결한 뒤 시간별 결과를 확인할 수 있습니다.");
  renderAnalytics(s);
  renderReviewCalendar(s);
  patternPanel.update(page, selectedMarket, data.trades);
  draw();
}

function selectPage(url, push = false) {
  const nextMarket = url === "/settings" ? selectedMarket : url.startsWith("/us") ? "US" : "KR";
  if (manualRunning && nextMarket !== selectedMarket) return;
  if (nextMarket !== selectedMarket) {
    selectedMarket = nextMarket; data = structuredClone(defaultState); tickQuotes = {}; loaded = false; failure = "";
    preview = false; announced = null; manualRequestId = null; modelFormVersion = null; lastAlertId = null; setText("#manual-message", "");
    Promise.resolve(refreshTask).finally(() => refresh());
  }
  page = ["/trades", "/settings", "/us", "/us/trades", "/reviews", "/us/reviews", "/patterns", "/us/patterns"].includes(url) ? url : "/";
  if (push && location.pathname !== page) history.pushState({}, "", page);
  const views = { "/": "dashboard", "/us": "dashboard", "/trades": "trades", "/us/trades": "trades", "/settings": "settings", "/reviews": "reviews", "/us/reviews": "reviews", "/patterns": "patterns", "/us/patterns": "patterns" };
  for (const name of new Set(Object.values(views))) $("#" + name).hidden = name !== views[page];
  $$(".nav a").forEach(link => {
    if (link.getAttribute("href") === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const titles = {
    "/patterns": ["차트패턴 분석", "국내장 거래에 패턴 조건을 적용한 가상 결과를 비교하세요."],
    "/us/patterns": ["미국장 차트패턴 분석", "미국장 거래의 수량·비용·환율을 유지한 가상 비교입니다."],
    "/": ["모의투자 대시보드", "토스증권 시세로 진행하는 한 달간의 자동 모의투자입니다."],
    "/trades": ["거래내역", "체결 금액과 판단 근거, 거래 직후의 손익을 확인하세요."],
    "/reviews": ["매매 복기", "장 마감 복기와 다음 거래일 전략 변경 근거를 확인하세요."],
    "/us/reviews": ["미국장 매매 복기", "미국 현지 거래일 기준의 일별 손익과 복기입니다."],
    "/settings": ["설정", "개인 API 키를 연결하고 모의투자 조건을 확인하세요."],
    "/us": ["미국장 모의투자", "미국 정규장에 맞춰 자동 분석하고, 거래 시점 환율로 원화 손익을 기록합니다."],
    "/us/trades": ["미국장 거래내역", "달러 체결가·적용 환율·원화 정산액과 매매 근거를 확인하세요."],
  };
  setText("#title", titles[page][0]);
  setText("#subtitle", titles[page][1]);
  $("#dashboard-actions").hidden = page === "/settings" || page.endsWith("/reviews") || page.endsWith("/patterns");
  if (page === "/settings") {
    preview = false;
    $("#api-form").reset();
    $("#form-result").hidden = true;
  }
  if (push) window.scrollTo(0, 0);
  render();
}

function notifyBrowser(title, message, id) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted" || localStorage.getItem("marketlab-notifications") !== "on"
      || localStorage.getItem("marketlab-last-notification") === id) return;
    new Notification(title, { body: message, tag: "marketlab" });
    localStorage.setItem("marketlab-last-notification", id);
  } catch {}
}

function renderAnalytics(s) {
  const a = s.analytics ?? {}, model = a.model;
  const cells = [["최대 낙폭", a.maxDrawdownPct == null ? "—" : fixed.format(a.maxDrawdownPct) + "%"],
    ["승률 · 매도 체결 기준", a.winRate == null ? "—" : fixed.format(a.winRate) + "%"],
    ["평균 이익 / 평균 손실", (a.averageWin == null ? "—" : money(a.averageWin)) + " / " + (a.averageLoss == null ? "—" : money(a.averageLoss))],
    ["이익 합계 / 손실 합계", a.profitFactor == null ? "손실 표본 없음" : fixed.format(a.profitFactor)],
    ["최대 연속 손실", (a.maxLossStreak ?? 0) + "회"], ["전체 / 매도 체결 수", (a.tradeCount ?? 0) + " / " + (a.sellFillCount ?? 0) + "건"],
    ["명시 비용 차감 전 참고손익", signed(a.pnlBeforeExplicitCosts ?? 0)],
    ["추정 양도세 차감 후 자산", money(a.afterEstimatedTax ?? s.totals.total)]];
  $("#risk-stats").innerHTML = cells.map(([label, value]) => '<div class="stat-cell"><span>' + safe(label) + '</span><strong>' + safe(value) + '</strong></div>').join("");
  setText("#strategy-version", model?.version ?? "새 모델 초기화 대기");
  const c = a.costs ?? {};
  setText("#cost-summary", "누적 차감 비용 " + money(a.explicitCosts ?? 0) + " · 수수료 " + money(c.commission ?? 0) + " · 거래세 " + money(c.transactionTax ?? 0)
    + " · 환전 스프레드 " + money(c.fxSpread ?? 0) + " / 호가 체결 가격차 " + signed(c.slippage ?? 0) + " (이미 체결가에 반영, 중복 차감 없음)"
    + (isUs() ? " · 연간 추정 양도세 " + money(a.estimatedCapitalTax ?? 0) + " (현금 미차감)" : ""));
  $("#fx-attribution").hidden = !isUs();
  const fx = a.attribution ?? {};
  setText("#fx-attribution", "주가 기여 " + signed(fx.pricePnl ?? 0) + " + 환율 기여 " + signed(fx.fxPnl ?? 0) + " + 비용·반올림 " + signed(fx.costPnl ?? 0)
    + " = 분석 대상 손익 " + signed(fx.total ?? 0) + " · 이전 방식 실현손익 " + signed(fx.legacyRealized ?? 0));
  const benchmarks = a.benchmarks ?? [];
  $("#benchmark-table").innerHTML = benchmarks.length ? table(["비교 대상", "측정 시작", "전략 원화 수익률", "시장 원화 가격수익률", "차이"], benchmarks.map(b => '<tr><td>' + safe(b.name) + '</td><td>' + stamp(b.since) + '</td><td>' + pct(b.strategyPct) + '</td><td>' + pct(b.returnPct) + '</td><td>' + pct(b.strategyPct - b.returnPct) + 'p</td></tr>')) : emptyImage("chart", "비교 데이터 수집 대기", "업데이트 이후 정규장 최신 시세부터 같은 기간의 비교를 시작합니다.");
  $("#daily-table").innerHTML = (a.daily ?? []).length ? table(["거래일", "시작 관측 자산", "마지막 관측 자산", "전일 관측 대비 손익", "수익률"], [...a.daily].reverse().slice(0, 35).map(row => '<tr><td>' + safe(row.date) + '</td><td>' + money(row.open) + '</td><td>' + money(row.close) + '</td><td>' + signed(row.pnl) + '</td><td>' + pct(row.returnPct) + '</td></tr>')) : '<p class="rules">일별 성과는 새 모델 적용 이후 관측치부터 기록합니다.</p>';
  $("#version-table").innerHTML = (a.versions ?? []).length ? table(["전략 버전", "적용 시각", "기간 평가수익률", "체결 수", "실현손익"], [...a.versions].reverse().map(v => '<tr><td>' + safe(v.id) + '</td><td>' + stamp(v.time) + '</td><td>' + (v.periodReturn == null ? "—" : pct(v.periodReturn)) + '</td><td>' + v.fillCount + '</td><td>' + signed(v.realized) + '</td></tr>')) + '<p class="rules">' + safe(a.notes) + '</p>' : "";
  const states = { PENDING: "미체결", PARTIAL_FILLED: "부분 체결", FILLED: "체결 완료", EXPIRED: "만료", CANCELED: "취소" };
  $("#paper-orders").innerHTML = (a.orders ?? []).length ? table(["주문 시각", "종목", "매매 · 방식", "지정가 · 만료", "상태", "체결 / 주문 수량", "사유"], a.orders.map(o => '<tr><td>' + stamp(o.createdAt) + '</td><td>' + safe(o.name) + '</td><td>' + (o.side === "BUY" ? "매수" : "매도") + '<div class="small">' + safe({RESTING_ENTRY:'눌림 지정가 대기',RESTING_TAKE_PROFIT:'목표가 사전 매도',MARKETABLE_LIMIT:'즉시 체결 우선'}[o.executionStyle] ?? '즉시 체결 우선') + '</div></td><td>' + (isUs() ? dollars(o.limitPrice) : money(o.limitPrice)) + '<div class="small">' + stamp(o.expiresAt) + '</div></td><td>' + safe(states[o.status] ?? o.status) + '</td><td>' + o.filledQuantity + ' / ' + o.quantity + '</td><td class="reason">' + safe(o.note) + '</td></tr>')) : emptyImage("list", "모의 주문이 없습니다", "매매 신호가 발생하면 체결 여부와 잔량을 기록합니다.");
  const alerts = a.alerts ?? [];
  $("#alerts-list").innerHTML = alerts.length ? alerts.slice(0, 15).map(item => '<div class="alert-row ' + (item.severity === "error" ? "error" : "") + '"><time>' + stamp(item.time) + '</time>' + safe(item.message) + '</div>').join("") : '<p class="rules">기록된 운영 알림이 없습니다. 브라우저 알림은 이 사이트가 열려 있는 동안 동작합니다.</p>';
  if (alerts[0]) {
    if (lastAlertId !== null && lastAlertId !== alerts[0].id) notifyBrowser("마켓랩 운영 알림", alerts[0].message, alerts[0].id);
    lastAlertId = alerts[0].id;
  } else lastAlertId = "none";
  const staleHeartbeat = health?.batchEnabled && health.lastMonitorTick && Date.now() - health.lastMonitorTick > 120000;
  setText("#server-health", failure ? "서버 연결 실패" : health ? staleHeartbeat ? "서버 감시 지연" : "서버 응답 정상 · " + stamp(health.now) : "서버 상태 확인 중");
  const ops = a.operations ?? {};
  setText("#monitor-health", "분석 10분 · 보유 감시 5초 · " + ({ closed: "정규장 외 대기", monitoring: "감시 중", waiting: "API 연결 대기", error: "감시 오류", stale: "시세 지연", finished: "기간 종료" }[ops.status] ?? "초기화 대기") + (ops.lastMonitor ? " · " + stamp(ops.lastMonitor) : ""));
  $("#server-health").className = failure || staleHeartbeat ? "loss" : "";
  $("#monitor-health").className = ["error", "stale"].includes(ops.status) ? "loss" : "";
  const profile = model?.config ?? { commissionBps: isUs() ? 10 : 1.5, taxBps: isUs() ? 0 : 20, fxSpreadBps: isUs() ? 10 : 0, participationPct: 10, limitBps: 20, ttlSeconds: 300 };
  const feeFormat = value => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 }).format(value / 100);
  setText("#conditions-costs", "수수료 " + feeFormat(profile.commissionBps) + "% · 주식 매도세 " + feeFormat(profile.taxBps) + "%");
  setText("#conditions-rules", (isUs() ? "미국 현지 정규장만 운영하며, 매 거래 시점 환율로 원화 정산합니다. " : "국내 정규장 연속매매 시간에 운영합니다. ")
    + "첫 신규 분석은 개장 3분 뒤, 이후 개장 기준 10분 간격, 보유 종목은 5초 간격으로 감시합니다. 최신 호가 잔량의 " + profile.participationPct + "% 이내에서 모의 체결하며, 즉시 체결 우선 주문은 " + profile.ttlSeconds + "초 뒤 만료됩니다. 일반 진입은 기준가보다 " + feeFormat(profile.limitBps) + "% 낮은 지정가로 최대 15분 대기하고, 강한 상승세(최근 분봉 +1% 이상)·뉴스 반응에는 즉시 체결을 우선합니다. 보유분은 +5% 목표가에 당일 매도 주문을 미리 두며 손절·악재·추세 약화 시 취소하고 보호 매도를 우선합니다. 최대 5종목·종목별 비중 상한 없이 가용 현금 내 주문, 주가 기준 −7% 손절·+5% 익절을 적용합니다. 감시 간격·가격 급변·잔량 부족으로 손절 가격의 체결은 보장하지 않습니다.");
  const version = selectedMarket + ":" + (model?.version ?? "default");
  if (modelFormVersion !== version && !$("#model-form").contains(document.activeElement)) {
    for (const [key, value] of Object.entries(profile)) $("#model-form").elements.namedItem(key).value = ["commissionBps", "taxBps", "fxSpreadBps", "limitBps"].includes(key) ? value / 100 : value;
    modelFormVersion = version;
  }
  drawBenchmark(benchmarks);
}

function drawBenchmark(benchmarks) {
  const canvas = $("#benchmark-chart"), width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const pixel = devicePixelRatio || 1; canvas.width = width * pixel; canvas.height = height * pixel;
  const ctx = canvas.getContext("2d"); ctx.scale(pixel, pixel); ctx.clearRect(0, 0, width, height);
  const all = benchmarks.flatMap(b => b.points ?? []);
  if (!all.length) { ctx.fillStyle = "#62657b"; ctx.font = "14px system-ui"; ctx.fillText("정규장 시세 수집 후 비교 그래프를 표시합니다.", 12, 36); return; }
  const minTime = Math.min(...all.map(p => p.time)), maxTime = Math.max(minTime + 60000, ...all.map(p => p.time));
  const values = all.flatMap(p => [p.benchmarkPct, p.strategyPct]);
  const min = Math.min(-0.1, ...values), max = Math.max(0.1, ...values), pad = Math.max((max - min) * .2, .1);
  const X = t => 52 + (width - 67) * (t - minTime) / (maxTime - minTime);
  const Y = p => 22 + (height - 50) * (max + pad - p) / (max - min + 2 * pad);
  ctx.font = "12px system-ui";
  for (const value of [min, 0, max]) { const y = Y(value); ctx.strokeStyle = "#e9e9f2"; ctx.beginPath(); ctx.moveTo(48, y); ctx.lineTo(width - 10, y); ctx.stroke(); ctx.fillStyle = "#62657b"; ctx.fillText(value.toFixed(1) + "%", 3, y + 4); }
  const lines = [{ name: "전략", points: benchmarks[0].points, key: "strategyPct", color: "#6545e2" }, ...benchmarks.map((b, i) => ({ name: b.name, points: b.points, key: "benchmarkPct", color: ["#168679", "#c68020"][i % 2] }))];
  lines.forEach((line, i) => { ctx.strokeStyle = line.color; ctx.lineWidth = 2; ctx.beginPath(); line.points.forEach((p, j) => j ? ctx.lineTo(X(p.time), Y(p[line.key])) : ctx.moveTo(X(p.time), Y(p[line.key]))); ctx.stroke(); ctx.fillStyle = line.color; ctx.fillText(line.name, 55 + i * 140, height - 5); });
  canvas.setAttribute("aria-label", lines.map(line => line.name + " " + pct(line.points.at(-1)?.[line.key] ?? 0)).join(", "));
}

let hover = null;
function draw() {
  const canvas = $("#chart");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const pixel = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * pixel);
  canvas.height = Math.round(height * pixel);
  const ctx = canvas.getContext("2d");
  ctx.scale(pixel, pixel);
  const data = current();
  const start = Date.parse(data.start + (isUs() ? "T09:30:00-05:00" : "T09:00:00+09:00"));
  const last = data.history.at(-1);
  const end = last?.time ?? Date.parse(data.end + "T00:00:00+09:00") - 1;
  const from = range === "7" ? Math.max(start, end - 6 * 86400000) : start;
  const before = data.history.filter(item => item.time < from).at(-1);
  const points = [{ time: from, total: before?.total ?? data.initial }, ...data.history.filter(item => item.time >= from)];
  if (!last) points.push({ time: end, total: data.initial });
  const min = Math.min(data.initial, ...points.map(p => p.total));
  const max = Math.max(data.initial, ...points.map(p => p.total));
  const pad = Math.max((max - min) * 0.25, 100000);
  const low = Math.max(0, Math.floor((min - pad) / 100000) * 100000);
  const high = Math.ceil((max + pad) / 100000) * 100000;
  const left = width < 460 ? 45 : 61;
  const right = width - 11;
  const top = 13;
  const bottom = height - 25;
  const X = time => left + (right - left) * (time - from) / Math.max(end - from, 1);
  const Y = amount => bottom - (bottom - top) * (amount - low) / (high - low);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = "#69657e";
  ctx.textAlign = "right";
  for (let step = 0; step <= 4; step++) {
    const y = top + step * (bottom - top) / 4;
    ctx.strokeStyle = "#eeecf4";
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillText(n.format(Math.round((high - step * (high - low) / 4) / 10000)) + "만", left - 7, y + 4);
  }
  ctx.textAlign = "center";
  const ticks = width < 390 ? 3 : 5;
  for (let step = 0; step < ticks; step++) {
    const fraction = step / (ticks - 1);
    ctx.fillText(axisFmt.format(from + fraction * (end - from)), left + fraction * (right - left - 7), height - 5);
  }
  const baseline = Y(data.initial);
  ctx.strokeStyle = "#b5a9d2";
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(left, baseline); ctx.lineTo(right, baseline); ctx.stroke(); ctx.setLineDash([]);
  const gradient = ctx.createLinearGradient(0, top, 0, bottom);
  gradient.addColorStop(0, "#a07bf859"); gradient.addColorStop(1, "#b898f606");
  ctx.beginPath(); ctx.moveTo(X(points[0].time), bottom);
  points.forEach(p => ctx.lineTo(X(p.time), Y(p.total)));
  ctx.lineTo(X(points.at(-1).time), bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath();
  points.forEach((p, index) => index ? ctx.lineTo(X(p.time), Y(p.total)) : ctx.moveTo(X(p.time), Y(p.total)));
  ctx.strokeStyle = "#7650e8"; ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.stroke();
  let selected = points.at(-1);
  if (hover !== null) selected = points.reduce((closest, value) => Math.abs(X(value.time) - hover) < Math.abs(X(closest.time) - hover) ? value : closest);
  const x = X(selected.time);
  const y = Y(selected.total);
  ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fillStyle = "#7650e8"; ctx.fill();
  ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.3; ctx.stroke();
  setText("#chart-note", hover !== null && last ? stamp(selected.time) + " · " + money(selected.total)
    : last ? "최근 기록 " + stamp(last.time) : "시작 원금 기준");
  canvas.setAttribute("aria-label", "평가자산 추이. " + (last ? "최신 기록 " + money(last.total) : "시작 원금 " + money(data.initial)));
}

function refresh() {
  refreshTask ??= refreshData().finally(() => { refreshTask = null; });
  return refreshTask;
}

async function refreshData() {
  const marketAtStart = selectedMarket;
  try {
    const next = await request("/api/state");
    if (marketAtStart !== selectedMarket) return;
    const last = next.trades.at(-1)?.id ?? "0";
    if (announced !== null && last !== announced && !preview) {
      const trade = next.trades.at(-1);
      if (trade) {
        const previous = Number(announced);
        $("#live-announcement").textContent = next.trades.filter(item => Number(item.id) > previous)
          .map(item => item.name + " " + (item.side === "BUY" ? "매수" : "매도") + " " + money(item.amount) + ", " +
            item.reason + ", 실현손익 " + signed(item.realized) + ", 총 평가자산 " + money(item.total)).join(" / ");
      }
    }
    announced = last;
    data = next;
    health = await request("/api/health").catch(() => null);
    failure = "";
    if (data.connected && data.positions.length && !preview && isDashboard() && !document.hidden) {
      try { const quotes = (await request("/api/quotes")).quotes; if (marketAtStart === selectedMarket) tickQuotes = quotes; } catch { if (marketAtStart === selectedMarket) tickQuotes = {}; }
    } else tickQuotes = {};
  } catch (error) {
    if (marketAtStart === selectedMarket) failure = error.message;
    notifyBrowser("서버 연결 실패", "마켓랩 서버에 연결하지 못했습니다. PC 전원과 인터넷을 확인해 주세요.", "offline:" + Math.floor(Date.now() / 300000));
  } finally {
    if (marketAtStart === selectedMarket) loaded = true;
    render();
  }
}

function showManualResult(message, error = false, traded = false) {
  setText("#manual-message", message);
  $("#manual-result").classList.toggle("error", error);
  $("#manual-trades").hidden = !traded;
  $("#manual-result").hidden = preview;
}

function showResult(message, error = false) {
  const result = $("#form-result");
  result.textContent = message;
  result.hidden = false;
  result.classList.toggle("error", error);
}

document.addEventListener("click", event => {
  const link = event.target.closest("a[data-page]");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  selectPage(link.getAttribute("href"), true);
});
window.addEventListener("popstate", () => selectPage(location.pathname));
$("#demo-toggle").addEventListener("click", () => { preview = !preview; render(); });
$("#manual-run").addEventListener("click", async () => {
  if (manualRunning || preview || !data.connected || data.finished) return;
  manualRunning = true;
  showManualResult("최신 시세를 모아 모의 거래 조건을 확인 중입니다.");
  render();
  try {
    manualRequestId ??= crypto.randomUUID();
    const result = await request("/api/manual-run", { requestId: manualRequestId });
    showManualResult(result.message, result.status === "error", result.trades.length > 0);
    manualRequestId = null;
    if (refreshTask) await refreshTask;
    await refresh();
  } catch (error) {
    showManualResult(error.message, true);
  } finally {
    manualRunning = false;
    render();
  }
});
$$("[data-filter]").forEach(button => button.addEventListener("click", () => {
  filter = button.dataset.filter;
  $$("[data-filter]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  render();
}));
$$("[data-range]").forEach(button => button.addEventListener("click", () => {
  range = button.dataset.range;
  $$("[data-range]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  draw();
}));
$("#chart").addEventListener("pointermove", event => { hover = event.offsetX; draw(); });
$("#chart").addEventListener("pointerleave", () => { hover = null; draw(); });
new ResizeObserver(draw).observe($(".plot"));
$("#reveal").addEventListener("click", () => {
  const show = $("#client-secret").type === "password";
  $("#client-secret").type = show ? "text" : "password";
  $("#reveal").setAttribute("aria-pressed", String(show));
  $("#reveal").setAttribute("aria-label", show ? "시크릿 숨기기" : "시크릿 표시");
});
const ipAddress = $("#connection-ip");
const checkIp = $("#check-ip");
const copyIp = $("#copy-ip");
const ipResult = $("#ip-result");

checkIp.addEventListener("click", async () => {
  checkIp.disabled = true;
  ipAddress.value = "";
  ipAddress.hidden = true;
  copyIp.hidden = true;
  ipResult.hidden = false;
  ipResult.textContent = "서버의 공인 IPv4를 확인 중입니다.";
  try {
    const { ip } = await request("/api/connection-ip");
    ipAddress.value = ip;
    ipAddress.hidden = false;
    copyIp.hidden = false;
    ipResult.textContent = "공인 IPv4를 확인했습니다.";
  } catch (error) {
    ipResult.textContent = error.message;
  } finally {
    checkIp.disabled = false;
  }
});

copyIp.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(ipAddress.value);
    ipResult.textContent = "IP 주소를 복사했습니다.";
  } catch {
    ipAddress.select();
    ipResult.textContent = "선택된 IP 주소를 복사해 주세요.";
  }
});

$("#api-form").addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("#client-id").value.trim();
  const secret = $("#client-secret").value.trim();
  if (!id || !secret) return showResult("Client ID와 Client Secret을 입력해 주세요.", true);
  $("#save").disabled = true;
  $("#disconnect").disabled = true;
  showResult("토스증권 시세 조회 연결을 확인 중입니다.");
  try {
    await request("/api/connect", { id, secret });
    event.target.reset();
    $("#client-secret").type = "password";
    $("#reveal").setAttribute("aria-pressed", "false");
    $("#reveal").setAttribute("aria-label", "시크릿 표시");
    showResult(data.batchEnabled ? "토스증권 API를 연결했습니다. 다음 정시부터 분석합니다." : "토스증권 API를 연결했습니다. 이 주소에서는 정시 배치가 실행되지 않습니다.");
    await refresh();
  } catch (error) {
    showResult(error.message, true);
  } finally {
    $("#save").disabled = false;
    $("#disconnect").disabled = false;
  }
});
$("#disconnect").addEventListener("click", async () => {
  if (!window.confirm("토스증권 API 연결을 해제할까요? 보유 종목과 거래내역은 계속 볼 수 있습니다.")) return;
  $("#disconnect").disabled = true;
  $("#save").disabled = true;
  try {
    await request("/api/disconnect", {});
    showResult("토스증권 API 연결을 해제했습니다.");
    await refresh();
  } catch (error) {
    showResult(error.message, true);
  } finally {
    $("#disconnect").disabled = false;
    $("#save").disabled = false;
  }
});
$("#enable-notifications").addEventListener("click", async () => {
  if (!("Notification" in window)) { $("#enable-notifications").textContent = "이 브라우저는 알림을 지원하지 않습니다"; return; }
  const permission = await Notification.requestPermission();
  try { localStorage.setItem("marketlab-notifications", permission === "granted" ? "on" : "off"); } catch {}
  $("#enable-notifications").textContent = permission === "granted" ? "브라우저 알림 켜짐 · 사이트 열림 중" : "알림 권한이 허용되지 않았습니다";
});
$("#model-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.target.querySelector("button"); button.disabled = true;
  try {
    const config = Object.fromEntries([...new FormData(event.target)].map(([key, value]) => [key,
      Number(value) * (["commissionBps", "taxBps", "fxSpreadBps", "limitBps"].includes(key) ? 100 : 1)]));
    await request("/api/model", config); modelFormVersion = null;
    setText("#model-result", "새 전략 버전으로 저장했습니다. 이후 모의 주문부터 적용됩니다."); await refresh();
  } catch (error) { setText("#model-result", error.message); }
  finally { button.disabled = false; }
});
const patternPanel = initPatterns(request);
initTradeChart({ request, market: () => selectedMarket, preview: () => preview, state: current });
selectPage(location.pathname);
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 25000);
let quoteRefreshRunning = false;
setInterval(async () => {
  if (quoteRefreshRunning || refreshTask || document.hidden || preview || !isDashboard() || !loaded || !data.connected || !data.positions.length) return;
  quoteRefreshRunning = true;
  const selectedAtStart = selectedMarket;
  try {
    const result = await request('/api/quotes');
    if (selectedAtStart === selectedMarket && !preview) { tickQuotes = result.quotes; render(); }
  } catch { /* The normal state refresh reports connection failures. */ }
  finally { quoteRefreshRunning = false; }
}, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

function renderReviewCalendar(s) {
  const calendar=s.reviewCalendar;
  if(!calendar){$("#review-calendar").textContent="복기 자료를 불러오는 중입니다.";return;}
  if(reviewMarket!==selectedMarket){reviewMarket=selectedMarket;reviewMonth=calendar.today.slice(0,7);reviewDate=[...calendar.days].reverse().find(d=>d.status==="final")?.date??calendar.today;loadingReview=null;}
  const [year,month]=reviewMonth.split('-').map(Number),count=new Date(Date.UTC(year,month,0)).getUTCDate(),offset=new Date(Date.UTC(year,month-1,1)).getUTCDay();
  setText("#review-month-title",year+"년 "+month+"월");
  const policy=calendar.policy;
  setText("#review-policy","현재 진입 상승세 "+policy.minimumMomentumPct.toFixed(2)+"% 이상 · 최대 호가 간격 "+policy.maximumSpreadPct.toFixed(2)+"% · "+(calendar.pending?calendar.pending.sourceDate+" 복기 보완을 다음 실제 거래일에 적용 예정":"마감 후 매일 보완 여부 검토 · 근거 부족 시 유지"));
  const byDate=new Map(calendar.days.map(d=>[d.date,d]));
  let html=['일','월','화','수','목','금','토'].map(d=>'<div class="calendar-weekday">'+d+'</div>').join('')+'<div class="calendar-gap"></div>'.repeat(offset);
  for(let day=1;day<=count;day++){
    const date=reviewMonth+'-'+String(day).padStart(2,'0'),row=byDate.get(date),available=!!row;
    html+='<button type="button" class="calendar-day '+(reviewDate===date?'selected ':'')+(row?.status==='final'?'final':'')+'" data-review-date="'+date+'" '+(!available?'disabled ':'')+'aria-pressed="'+(reviewDate===date)+'" aria-label="'+date+(row?' 평가손익 '+(row.equityPnl==null?'미확인':signed(row.equityPnl)):' 기록 없음')+'"><span>'+day+'</span>'+(row?'<strong class="'+tone(row.equityPnl??0)+'">'+(row.equityPnl==null?'—':signed(row.equityPnl))+'</strong><small>'+({final:'복기 완료',pending:'마감 후 작성',unavailable:'자료 확인 대기'}[row.status])+(row.changed?' · 보완 예약':'')+'</small>':'<small>기록 없음</small>')+'</button>';
  }
  $("#review-calendar").innerHTML=html;
  const row=byDate.get(reviewDate),key=selectedMarket+':'+reviewDate;
  if(!row||row.status!=='final'){$("#review-detail").innerHTML='<h2>'+safe(reviewDate??'날짜 선택')+'</h2><p class="news-summary">'+(row?.status==='pending'?'장이 끝나고 마감 평가가 저장되면 복기를 자동 작성합니다. 진행 중인 손익은 확정 결과가 아닙니다.':'이 날짜의 완성된 복기 자료가 없습니다.')+'</p>';return;}
  const cacheKey=key+':'+(row.closingRevision??'legacy');
  if(reviewCache.has(cacheKey)){renderReviewReport(reviewCache.get(cacheKey),calendar);return;}
  $("#review-detail").innerHTML='<h2>'+safe(reviewDate)+'</h2><p>복기 내용을 불러오는 중입니다.</p>';
  if(loadingReview===cacheKey||!page.endsWith('/reviews'))return;
  loadingReview=cacheKey;
  request((isUs()?'/api/us/reviews':'/api/reviews')+'?date='+encodeURIComponent(reviewDate)).then(result=>{
    reviewCache.set(cacheKey,result.report);if(key===selectedMarket+':'+reviewDate)renderReviewReport(result.report,data.reviewCalendar);
  }).catch(error=>{if(key===selectedMarket+':'+reviewDate)$("#review-detail").innerHTML='<p class="loss">'+safe(error.message)+'</p>';}).finally(()=>{if(loadingReview===cacheKey)loadingReview=null;});
}
function renderClosingAudit(report) {
  const audit=report.closingAudit;
  if(!audit)return '<h3>종가 별도 확인</h3><p class="news-meta">별도 조회 작업을 준비하고 있습니다.</p>';
  const targets=audit.targets??[],confirmed=targets.filter(t=>audit.records[t.symbol]?.status==='confirmed').length;
  const basis=report.market==='KR'?'KRX·NXT 통합 일봉 종가 · 시간외장 포함':'미국 정규장 공식 일봉 종가';
  const state={waiting:'마감 확정 대기',checking:'확인 중',partial:'미확인 종목 재조회 중',complete:'전체 종가 확인 완료'}[audit.status]??'확인 대기';
  const rows=targets.map(t=>{const r=audit.records[t.symbol];return '<tr><td>'+safe(t.name??t.symbol)+'<span class="small"> '+safe(t.symbol)+'</span></td><td>'+({confirmed:'확인 완료',retry:'재조회 대기'}[r?.status]??'조회 대기')+'</td><td>'+(r?.price?(report.market==='US'?dollars(r.price):money(r.price)):'—')+'</td><td>'+(r?.checkedAt?stamp(r.checkedAt):'—')+'</td><td>'+safe(r?.reason??'')+'</td></tr>';});
  const value=audit.valuationStatus==='complete'?'<p>확인 종가 기준 평가금액 <strong>'+money(audit.equity)+'</strong></p>':'';
  const fx=report.market==='US'&&audit.fx?'<p class="news-meta">환율은 정규장 마감 이전 마지막 저장값 '+fixed.format(audit.fx.rate)+'원 ('+stamp(audit.fx.time)+')을 고정했습니다.</p>':'';
  return '<section class="closing-audit"><div class="card-heading"><div><h3>전체 종목 종가 확인</h3><p>'+basis+'</p></div><span class="plain-badge">'+state+' · '+confirmed+'/'+targets.length+'종목</span></div><p class="news-meta">해당 거래일의 보유·거래 종목 전체 · 확인 시작 '+(audit.eligibleAt?stamp(audit.eligibleAt):'장 일정 확인 후')+' · API 한도를 지키며 미확인 종목을 재조회합니다.</p>'+value+fx+'<details><summary>종목별 종가와 확인 상태</summary>'+table(['종목','상태','확인 종가','조회 시각','확인 사항'],rows)+'</details></section>';
}
function renderDayChartReview(stock,report) {
  const day=stock.dayChart;if(!day)return '';
  const status={confirmed:'당일 분봉 조회 완료',partial:'부분 자료 · 재조회 예정',retry:'조회 실패 · 재시도 예정',waiting:'마감 후 수집 대기'}[day.status]??'확인 대기';
  const formatPrice=p=>report.market==='US'?dollars(p):money(p);
  const point=p=>p&&Number.isFinite(p.price)?formatPrice(p.price)+'<div class="small '+tone(p.changePct)+'">'+pct(p.changePct)+' · '+stamp(p.time)+'</div>'+(p.differenceKrw==null?'':'<div class="small">가격차 참고 '+signed(p.differenceKrw)+'</div>'):'—';
  const notes=[...new Set(day.analyses.map(a=>a.suggestion).filter(Boolean))];
  const rows=day.analyses.map(a=>'<tr><td>'+stamp(a.time)+'<div class="small">'+(a.side==='SELL'?'매도':'매수')+' '+n.format(a.quantity)+'주 · '+formatPrice(a.price)+'</div></td>'
    +a.checkpoints.map(p=>'<td>'+point(p.available?p:null)+'</td>').join('')+'<td>고가 '+point(a.high)+'<br>저가 '+point(a.low)+'</td><td>'+point(a.last)+'</td><td class="reason">'+safe(a.judgement)+'</td></tr>');
  return '<section class="day-chart-review"><h5>마감 후 하루 차트로 판단 재검토</h5><p><span class="plain-badge">'+status+'</span> · '+day.coverage.bars+'개 봉'+(day.checkedAt?' · 조회 '+stamp(day.checkedAt):'')+'</p>'
    +(day.coverage.bars?'<p class="news-meta">'+safe(day.source)+' · 3분 초과 자료 공백 '+day.coverage.gaps+'곳 · 장 종료와 마지막 봉 간격 '+fixed.format(day.coverage.closingGapMinutes??0)+'분. 매매가 포함된 1분봉의 고가·저가는 제외합니다.</p>':'<p class="news-meta">당시 관측값이 없어도 장 마감 후 당일 거래 종목의 1분봉을 별도로 확인합니다. 과거 거래일도 순차 보완하며 실패한 종목은 재조회합니다.</p>')
    +(notes.length?'<ul>'+notes.map(t=>'<li>'+safe(t)+'</li>').join('')+'</ul>':'')+'<details><summary>체결별 5·15·30분 대안과 매매 이후 경로</summary>'+table(['체결','5분 뒤','15분 뒤','30분 뒤','이후 확인 고가·저가','마지막 확인 분봉','판단 검토'],rows)+'</details><p class="news-meta">'+safe(day.note)+'</p></section>';
}
function renderReviewReport(report,calendar) {
  if(!report){$("#review-detail").innerHTML='<p>보고서가 아직 작성되지 않았습니다.</p>';return;}
  const reviewTable=(heads,rows)=>table(heads,rows.map(row=>"<tr>"+row.map(value=>"<td>"+safe(value)+"</td>").join("")+"</tr>"));
  const s=report.summary,adaptive=report.adaptive,applied=calendar.applied?.find(r=>r.reviewDate===report.date);
  const status=applied?'적용 완료':calendar.pending?.sourceDate===report.date?'다음 거래일 적용 예약':adaptive.changed?'당시 보완안 기록':'기존 전략 유지';
  const equityLabel=report.closingAudit?.valuationStatus==='complete'?(report.market==='KR'?'통합종가 평가손익':'정규장 종가 평가손익'):'평가손익';
  const stats=[[equityLabel,s.equityPnl==null?'확인 불가':signed(s.equityPnl)],['실현손익',signed(s.realized)],['명시 비용',money(s.explicitCosts)],['체결 수',s.fillCount+'건 (매수 '+s.buyCount+' / 매도 '+s.sellCount+')']];
  const stocks=(report.stocks??[]).map(t=>'<article class="stock-review"><div class="card-heading"><div><h4>'+safe(t.name)+' <span class="news-meta">'+safe(t.symbol)+'</span></h4><p>'+t.fillCount+'건 체결 · 매수 '+n.format(t.buyQuantity)+'주 / 매도 '+n.format(t.sellQuantity)+'주</p></div><button type="button" class="trade-chart-link" data-trade-chart="'+safe(t.chartTradeId)+'" data-chart-date="'+safe(report.date)+'">하루 매매 차트 보기</button></div><h5>왜 매매했나</h5><p>'+safe(t.motivation)+'</p>'+(t.sellReasons.length?'<p>매도 판단: '+t.sellReasons.slice(0,3).map(r=>safe(r.text)+' ('+r.fills+'건 · '+n.format(r.quantity)+'주)').join(' / ')+(t.sellReasons.length>3?' 외 '+(t.sellReasons.length-3)+'개 판단':'')+'</p>':'')+'<h5>어떤 결과였나</h5><p>'+safe(t.outcome)+'</p><p>실현손익 <strong class="'+tone(t.realized)+'">'+signed(t.realized)+'</strong> · 기록된 명시 비용 '+money(t.explicitCosts)+(t.missingCostFills?' · 비용 상세 미저장 '+t.missingCostFills+'건':'')+'</p><h5>어떻게 했으면 더 나았나</h5><ul>'+t.improvements.map(v=>'<li>'+safe(v)+'</li>').join('')+'</ul>'+renderDayChartReview(t,report)+'</article>').join('');
  $("#review-detail").innerHTML='<div class="card-heading"><div><h2>'+safe(report.date)+' 매매 복기</h2><p>'+(report.market==='US'?'미국 현지 거래일':'한국 거래일')+' · 작성 '+stamp(report.createdAt)+'</p></div><span class="plain-badge">'+status+'</span></div><div class="stat-grid">'+stats.map(([k,v])=>'<div class="stat-cell"><span>'+k+'</span><strong>'+safe(v)+'</strong></div>').join('')+'</div><p class="news-summary">'+safe(report.overview)+'</p>'+renderClosingAudit(report)+'<section class="closing-audit"><div class="card-heading"><div><h3>당일 차트 사후 보완</h3><p>'+(report.dayChartReview?report.dayChartReview.confirmed+' / '+report.dayChartReview.total+'종목 분봉 확인':'마감 후 당일 거래 종목의 분봉을 확인합니다.')+'</p></div><button type="button" class="button secondary" data-review-chart-refresh="'+safe(report.date)+'">당일 차트 확인</button></div><p id="review-chart-status" class="news-meta">과거 거래일도 확인할 수 있습니다. 한 번에 최대 2종목씩 조회하며 전체가 확인되지 않으면 다시 누르거나 장외 자동 보완을 기다려 주세요. 매매 실행·기존 전략 변경은 없습니다.</p></section><h3>종목별 종합 복기</h3>'+(stocks||'<p>당일 체결이 없습니다.</p>')+'<h3>종합 복기와 대안</h3>'+reviewTable(['매도 사유','체결 수','실현손익'],Object.entries(report.exitReasons).map(([reason,row])=>[reason,String(row.count),signed(row.realized)]))+'<ul>'+report.lessons.map(v=>'<li>'+safe(v)+'</li>').join('')+'</ul><p>'+safe(report.alternatives)+'</p><p>분석 성공 기록 '+report.analysis.success+'회 · 실패 '+report.analysis.failed+'회</p><h3>다음 거래일 전략 보완 · '+status+'</h3>'+reviewTable(['항목','검토 전','보완안'],[['진입 상승세',adaptive.before.minimumMomentumPct.toFixed(2)+'%',adaptive.after.minimumMomentumPct.toFixed(2)+'%'],['최대 호가 간격',adaptive.before.maximumSpreadPct.toFixed(2)+'%',adaptive.after.maximumSpreadPct.toFixed(2)+'%']])+'<ul>'+adaptive.reasons.map(v=>'<li>'+safe(v)+'</li>').join('')+'</ul><p class="news-meta">완결 매매 '+adaptive.sample.completedTrips+'회 · '+adaptive.sample.distinctDays+'개 거래일 표본. '+safe(adaptive.limits)+'</p>'+(report.quality.length?'<h3>자료의 한계</h3><ul>'+report.quality.map(v=>'<li>'+safe(v)+'</li>').join('')+'</ul>':'')+'<p class="news-meta">'+safe(report.method)+'</p>';
}
document.addEventListener('click',event=>{
  const dateButton=event.target.closest('[data-review-date]'),monthButton=event.target.closest('[data-month-shift]');
  if(dateButton&&!dateButton.disabled){reviewDate=dateButton.dataset.reviewDate;renderReviewCalendar(data);}
  if(monthButton){const [y,m]=reviewMonth.split('-').map(Number),date=new Date(Date.UTC(y,m-1+Number(monthButton.dataset.monthShift),1));reviewMonth=date.toISOString().slice(0,7);reviewDate=data.reviewCalendar?.days.filter(d=>d.date.startsWith(reviewMonth)).at(-1)?.date??reviewMonth+'-01';renderReviewCalendar(data);}
});
function renderEvents(watch) {
  const status = {ok:"정상",closed:"장외 15분 확인",degraded:"일부 수집 장애",unavailable:"수집 확인 불가",waiting:"첫 감시 대기"};
  setText("#event-health", status[watch?.status] ?? "첫 감시 대기");
  const sources = (watch?.sources ?? []).map(source => '<span class="event-source ' + (source.status === "ok" ? "" : "loss") + '">' + safe(source.name) + ' · ' + safe({ok:"정상",blocked:"접근 차단",error:"조회 실패",stale:"확인 지연"}[source.status] ?? "대기") + (source.successAt ? ' · 최근 성공 ' + stamp(source.successAt) : '') + (source.status !== "ok" && source.nextAttempt ? ' · 재확인 ' + stamp(source.nextAttempt) : '') + '</span>').join('');
  const links = (watch?.items ?? []).filter(item => item.link.startsWith("https://")).slice(0,8).map(item => '<li><a href="' + safe(item.link) + '" target="_blank" rel="noopener noreferrer">' + safe(item.title) + '</a><span class="small">' + safe(item.source) + ' · 게시 ' + stamp(item.time) + '</span></li>').join('');
  const reactions = (watch?.reactions ?? []).slice(-5).reverse().map(item => '<div class="alert-row"><time>' + stamp(item.time) + '</time>' + safe(item.action) + ' · ' + safe(item.title) + '</div>').join('');
  $("#event-watch").innerHTML = '<p class="news-meta">' + (watch?.lastChecked ? '최근 확인 ' + stamp(watch.lastChecked) : '정규장 중 API 연결 후 감시를 시작합니다.') + ' · 정보원 게시 지연과 수집 장애에 따라 반영이 늦을 수 있습니다.</p>' + '<div class="event-sources">' + sources + '</div>' + (reactions ? '<details><summary>최근 대응 기록</summary>' + reactions + '</details>' : '') + (links ? '<details><summary>최근 수집 뉴스·공시</summary><ul class="news-items">' + links + '</ul></details>' : '<p class="news-meta">수집 범위에 표시할 새 항목이 없습니다. 공시가 없는 것과 수집 장애는 위 상태에서 구분합니다.</p>');
}


document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-review-chart-refresh]');if(!button||button.disabled)return;
  const market=selectedMarket,date=button.dataset.reviewChartRefresh;button.disabled=true;
  setText('#review-chart-status','당일 분봉을 확인하고 있습니다.');
  try{const r=await request(market==='US'?'/api/us/reviews/charts':'/api/reviews/charts',{date});reviewCache.clear();await refreshData();
    if(selectedMarket===market&&reviewDate===date)showNotice(r.status==='complete'?'당일 거래 종목 전체의 분봉을 확인했습니다.':r.confirmed+' / '+r.total+'종목 확인 · 나머지는 한도와 재시도 시각을 지키며 보완합니다.');
  }catch(error){if(selectedMarket===market)showNotice(error.message,true);}finally{button.disabled=false;}
});
