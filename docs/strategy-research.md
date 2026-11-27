# Codex 일일 전략 연구와 과거 재현

사용자는 2026-11-27 매일 Codex가 복기하고 전략을 연구·보완하도록 요청했다. 백테스트 범위는 2026-05-01부터 마지막 완료 거래일까지 코스피이며 당시 뉴스·공시와 필요한 차트 패턴을 포함한다. 소스 변경은 기존 변경 기록·일반 Git push 절차를 따른다.

## 실행

저장소 루트에서 아래 명령을 실행한다.

    node research/collect.mjs
    node research/run.mjs
    node --test

원자료·결과는 Git에서 제외된 outputs/research에 저장한다. collect는 완료된 코스피 일봉과 수집 해시를 저장한다. 지수 변동률은 참고 기준이며 투자전략 순수익으로 표시하지 않는다. 현재 확보한 구간은 2026-05-04~11-26, 140거래일이다. historical-archive.json이 없으면 run은 blocked와 부족 자료를 기록한다.

## 역사 자료 계약

historical-archive.json은 market KR, start 2026-05-01, sessionDates, snapshots, events를 포함한다. 원본 제공자·수집 시각·완전성 확인 근거는 별도 manifest로 보관한다. 전체 코스피 구성종목은 각 날짜의 실제 상장·상장폐지 상태를 포함해야 한다. 현재 생존 종목만으로 당시 전체 시장을 재현했다고 소개하지 않는다.

각 snapshot에는 date, symbol, name, type, time, availableAt, price, regularStart, regularEnd, previousPrices, previousAvailableAt, candidate, book, coverage를 넣는다. candidate에는 당시 eligible, signalTime, momentum, score, reason을 저장한다. 후보 순위 선정 근거는 당시 저장 자료 또는 과거 전 종목 자료로 재구축해야 한다. book은 time, asks/bids 가격·volume을 포함한다. coverage는 news/disclosures complete, universe point-in-time, from/until과 근거 자료로 구성한다. 자료가 없는 날짜를 complete로 선언하지 않는다.

각 event에는 symbol 또는 MARKET, kind news/disclosure, title, source, url, publishedAt, availableAt, versionAt을 저장한다. 현재 수정된 기사 본문에 과거 발표 시각만 붙이지 않는다. 당시 원문을 확보하지 못하면 해당 내용의 과거 사용을 보류한다. 공시 목록의 접수 날짜만으로 장중 발표 시각을 추측하지 않는다. 정정 공시는 별도 버전으로 취급한다. 패턴은 당시 완성된 봉에 observedAt을 포함해 기존 detectPatterns에 전달한다.

## 연구·검증 절차

replay는 기존 모의 체결·비용·포트폴리오 엔진을 독립 원장에서 실행한다. 현재 뉴스 제목 분류기를 재사용해 발표된 악재를 반영한다. 기사 전문 AI 판단을 완료한 것으로 소개하지 않는다. Codex는 당시 원문이 확보된 경우에만 원문 근거를 인용해 연구 가설과 분류 개선을 작성한다. 분석에 사용한 자료와 변경 이유를 기록한다.

초기 탐색은 상승세 0.15/0.20/0.25%, 호가 간격 0.10/0.15/0.20%, 패턴 필터 유무의 18조합이다. 5~8월 학습, 9~10월 후보 선정, 11월 별도 평가 순서다. 별도 평가를 반복 확인하며 매개변수를 고르면 그 구간은 이후 개발 자료로 편입하고 새 미래 구간을 확보한다. 현금 시작 구간별 비교이며 월간 연속 운용 수익과 구분한다. 표본·수익·최대 낙폭·수수료·미체결·데이터 누락을 함께 보고한다.

손절7%, 익절5%, 계좌 매수 중단과 위험 한도는 최근 사용자 결정이다. 연구 탐색에서는 유지한다. 초기 후보 조건은 검증 구간 순이익, 매도 주문5건 이상, 최대 낙폭5% 이하다. 이는 검증용 가정이다. 수익률 순위만으로 운영 적용을 허용하지 않는다. 현재 실행기는 자동 승격을 하지 않는다. 기존 운영 기준과 동일 자료 비교, 자료 완전성, 회귀 테스트와 신규 모의 전진 검증을 거쳐 Codex가 적용 근거를 남겨야 한다. 검증된 변경이 없으면 기존 알고리즘을 유지한다.

## 일일 Codex 작업

한국 시간08:40에 Codex가 전날 두 시장 자료와 기존 개선 가설의 결과를 검토한다. 후보 전략별 설명과 실험 이력을 남긴다. 자료 누락을 먼저 확인하고 확보된 증거 안에서 비교한다. 소스·테스트 수정 후 검증하고 기존 운영 절차로 반영한다. 실거래 준비 모듈은 계속 비활성이다. 기존 개발기·거래 일지 예약과 별도 연구 작업이다.

## 현재 결과와 부족 자료

일봉 수집과 검사 코드를 실행했고 역사 자료 미확보로 전체 전략 재현은 blocked다. 최적 수익률이나 검증된 개선 알고리즘은 아직 선정하지 않았다. 과거 분봉·호가·당시 후보 및 상장 구성, 발표·정정 시각을 포함한 뉴스·공시 아카이브가 필요하다. 현재 RSS는 이 기간 전체의 역사 아카이브를 제공하지 않는다. OpenDART 목록 API에는 별도 인증키가 필요하며 접수 날짜만으로 장중 가용 시각을 입증할 수 없다.

자료 조회 구현 참고
- https://github.com/FinanceData/FinanceDataReader/blob/master/src/FinanceDataReader/naver/data.py
- https://developers.tossinvest.com/docs/market-data
- https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DE001&apiId=AE00001
