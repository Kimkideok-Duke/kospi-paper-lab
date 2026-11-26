import { patternReport } from './pattern-engine.mjs';

const $ = selector => document.querySelector(selector);
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
const money = value => value == null ? '—' : (value > 0 ? '+' : '') + number.format(value) + '원';
const tone = value => value > 0 ? 'gain' : value < 0 ? 'loss' : '';
const stamp = value => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
const table = (headers, rows) => '<div class="table-scroll" tabindex="0"><table><thead><tr>' + headers.map(h => '<th scope="col">' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(v => '<td>' + v + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';

function example(market) {
  const trades = [], start = Date.parse('2026-11-26T11:00:00+09:00');
  const base = [108, 106, 103, 100, 101, 103, 106, 109, 106, 103, 101, 100.2, 102, 104, 106, 108, 108.3, 108.6, 108.8, 110];
  for (let i = 0; i < 4; i++) {
    const time = start + i * 3 * 3600_000;
    const prices = i === 1 ? base.map(v => 210 - v) : i === 2 ? base.map((_, j) => 100 + j * .2) : base;
    const points = prices.map((price, j) => ({ time: time - (prices.length - 1 - j) * 60_000, price }));
    trades.push({ id: String(i * 2 + 1), symbol: 'EXAMPLE' + i, name: ['상승 돌파 예시', '하락 돌파 예시', '무신호 예시', '자료 부족 예시'][i], side: 'BUY', time, quantity: 10, price: prices.at(-1), priceUsd: prices.at(-1),
      patternEvidence: { source: 'candles', points: i === 3 ? points.slice(-5) : points }, costs: {} });
    trades.push({ id: String(i * 2 + 2), symbol: 'EXAMPLE' + i, side: 'SELL', time: time + 3600_000, quantity: 10, realized: [50000, -30000, 10000, -15000][i], costs: {} });
  }
  return { trades };
}

function chart(row) {
  if (row.points.length < 2) return '<p class="news-meta">차트를 그릴 가격 자료가 없습니다.</p>';
  const points = row.points, levels = row.signals.map(s => s.level), min = Math.min(...points.map(p => p.price), ...levels), max = Math.max(...points.map(p => p.price), ...levels);
  const from = points[0].time, to = points.at(-1).time, X = t => 40 + 680 * (t - from) / Math.max(1, to - from), Y = p => 175 - 140 * (p - min) / Math.max(.01, max - min);
  const path = points.map((p, i) => (i ? 'L' : 'M') + X(p.time).toFixed(2) + ',' + Y(p.price).toFixed(2)).join(' ');
  return '<svg class="pattern-chart" viewBox="0 0 760 215" role="img" aria-label="' + safe(row.name) + ' 진입 직전 가격과 패턴 경계"><title>진입 이전 가격만 표시</title>' +
    '<path class="pattern-price" d="' + path + '"/>' + row.signals.map(s => '<line class="pattern-level" x1="40" x2="720" y1="' + Y(s.level).toFixed(2) + '" y2="' + Y(s.level).toFixed(2) + '"/><text x="45" y="' + (Y(s.level) - 7).toFixed(2) + '">' + safe(s.name) + ' · 돌파 경계 ' + number.format(s.level) + '</text>' + (s.anchors ?? []).map(p => '<circle class="pattern-anchor" cx="' + X(p.time).toFixed(2) + '" cy="' + Y(p.price).toFixed(2) + '" r="4"/>').join('')).join('') +
    '<text x="40" y="205">' + stamp(from) + '</text><text text-anchor="end" x="720" y="205">' + stamp(to) + ' · 진입 직전</text></svg>';
}

export function initPatterns(request) {
  let market = 'KR', active = false, report = null, key = '', sequence = 0, sample = false, running = false;
  const form = $('#pattern-form'), status = $('#pattern-status');
  const options = () => Object.fromEntries(new FormData(form));
  function render() {
    if (!report) return;
    const s = report.summary;
    $('#pattern-summary').innerHTML = [['기존 손익 · 비교 가능 거래', money(s.baseline), s.baseline], ['패턴 적용 가상 손익', money(s.simulated), s.simulated], ['기존 대비 차이', money(s.difference), s.difference], ['비교 가능 / 완결 거래', s.comparable + ' / ' + s.completed + '묶음', 0]].map(([label, value, amount]) => '<article class="card pattern-metric"><span>' + label + '</span><strong class="' + tone(amount) + '">' + value + '</strong></article>').join('');
    status.textContent = (sample ? '화면 확인용 가상 예시입니다. 실제 거래 결과가 아닙니다. ' : (market === 'US' ? '미국장' : '국내장') + ' 저장 원장 기준 · ') + '유지 ' + s.kept + ' · 회피 ' + s.skipped + ' · 자료 부족 ' + s.unavailable + ' · 진행 중 ' + s.open + (s.unmatched ? ' · 매수 기록 없는 매도 ' + s.unmatched : '') + ' · 모든 시각은 한국 시간';
    const root = $('#pattern-results'), expanded = new Set([...root.querySelectorAll('details[open]')].map(e => e.dataset.cycle));
    root.innerHTML = report.rows.length ? [...report.rows].reverse().map(r => '<details class="pattern-cycle" data-cycle="' + safe(r.id) + '"' + (expanded.has(r.id) ? ' open' : '') + '><summary><span><strong>' + safe(r.name) + '</strong><small>' + safe(r.symbol) + ' · ' + stamp(r.entryTime) + ' ~ ' + stamp(r.exitTime) + '</small></span><span class="plain-badge">' + ({ keep: '매수 유지', skip: '매수 회피', unavailable: '자료 부족' }[r.decision]) + '</span><strong class="' + tone(r.difference) + '">차이 ' + money(r.difference) + '</strong></summary>' +
      table(['매수 수량', '기존 실현손익', '패턴 적용 가상 손익', '차이'], [[number.format(r.quantity) + '주', money(r.baseline), money(r.simulated), money(r.difference)]]) +
      '<p class="news-summary">' + safe(r.reason) + (r.signals.length ? ' · ' + r.signals.map(s => safe(s.name)).join(', ') : '') + '</p><p class="news-meta">' + (sample ? '생성한 가상 가격 자료' : r.evidenceSource === 'candles' ? '거래 당시 보관한 1분봉 종가' : '저장 관측가로 사후 재구성 · 당시 수신 시각 미상인 이전 자료 포함 가능') + ' · 가격 ' + r.points.length + '개 · 부분 체결 포함 ' + r.fillCount + '건' + (!r.costsKnown ? ' · 이전 거래: 비용 상세 없음, 저장 실현손익 기준' : '') + '</p>' + chart(r) + '</details>').join('') : '<div class="empty"><strong>아직 완결된 거래가 없습니다</strong><span>매수 후 전량 매도된 거래부터 비교합니다. 분석 예시 보기로 화면을 확인할 수 있습니다.</span></div>';
    $('#pattern-breakdown').innerHTML = table(['패턴', '해당 거래 묶음', '기존 실현손익', '조건 적용 차이'], report.perPattern.map(p => [safe(p.name), String(p.count), p.count ? money(p.baseline) : '—', p.count ? money(p.difference) : '—']));
  }
  async function load() {
    if (!active) return;
    const token = ++sequence, selectedMarket = market, params = options();
    running = true; form.querySelector('[type=submit]').disabled = true;
    status.textContent = '저장된 거래와 진입 이전 가격을 분석 중입니다.';
    try {
      const result = sample ? patternReport(example(market), market, { ...params, tolerance: Number(params.tolerance), lookback: Number(params.lookback) })
        : await request((market === 'US' ? '/api/us/patterns' : '/api/patterns') + '?' + new URLSearchParams(params));
      if (token !== sequence || market !== selectedMarket) return;
      report = result; render();
    } catch (error) {
      if (token !== sequence) return;
      report = null; status.textContent = error.message;
      $('#pattern-summary').innerHTML = ''; $('#pattern-results').textContent = '분석 자료를 불러오지 못했습니다. 분석하기를 눌러 다시 시도하세요.'; $('#pattern-breakdown').innerHTML = '';
    } finally {
      if (token === sequence) { running = false; form.querySelector('[type=submit]').disabled = false; }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); load(); });
  $('#pattern-example').addEventListener('click', () => { sample = !sample; $('#pattern-example').textContent = sample ? '실제 거래 분석 보기' : '분석 예시 보기'; $('#pattern-example').setAttribute('aria-pressed', String(sample)); load(); });
  return { update(page, selectedMarket, trades = []) {
    const wasActive = active;
    active = page.endsWith('/patterns');
    const nextKey = selectedMarket + ':' + trades.length + ':' + (trades.at(-1)?.id ?? '');
    if (market !== selectedMarket) { market = selectedMarket; report = null; sequence++; running = false; }
    if (active && (!wasActive || key !== nextKey)) { key = nextKey; load(); }
  } };
}
