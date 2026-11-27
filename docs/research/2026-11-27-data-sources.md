# 백테스트 자료 제공처와 확보 절차

2026-11-27 조사. 대상은2026-05-01~11-26이다. 제공 사양 확인과 실제 자료 확보를 구분한다. 구매·결제·외부 문의 발송은 수행하지 않았다.

## 먼저 이용할 경로

| 자료 | 확인한 제공처·사양 | 확보 절차와 남은 확인 |
|---|---|---|
| 과거1분봉 | 토스 공식 FAQ: 국내2022-11-23 이후 제공 | 기존 마켓랩 연결에서5월 표본 조회 후 확대. 이번 조사에서는 인증된5월 응답을 받지 않았음 |
| 과거 호가·체결 | KRX 주식 상품의 호가장·체결장: 밀리초 단위. 일중 매매정보:1분·10분 단위 | 회원 로그인 후 상품 선택. 5월 주문 가능 여부·가격·필드 상세는 미확인 |
| 당시 전체 종목·일별 시세 | KRX OPEN API 유가증권 종목기본정보·일별매매정보. 기본정보는2010년 이후 제공 안내 | 회원가입 → 인증키 승인 → 각 API 활용 신청 승인. 날짜별 목록과 상장·상장폐지 내역 대조 필요 |
| 공시 | DART 공개 날짜 검색·OpenDART | 공개 목록26,132건 일부 수집. API는 인증키 필요. 원공시·정정공시와 접수 시각 분리 |
| 뉴스 | 빅카인즈 기간·종목 검색과 분석 결과 다운로드, 필요한 전문은 언론사·뉴스스토어 | 발표·수정 시각 대조. FAQ의 다운로드 본문200자 제한과 별도 전문 상품 안내를 확인했으나 재조회는 시간 초과. 전문 비용·자동 수집 권한은 추가 확인 |
| X 과거 글 | 공식 Full-Archive Search:2006년 이후 검색 | 개발자 계정·앱 Bearer Token·사용량 과금 접근 필요. 일반 로그인과 API 권한은 별개. 실제 확보0건 |
| 커뮤니티 | 팍스넷 공개 종목토론 | 현재 표본31건. 5월 이후 전체 과거 글·수정 이력은 미확보 |

## 토스 분봉은 기존 연결부터 사용

올해5월은 공식 문서상 조회 대상이다. 분봉 미보유와 공급처 부재를 혼동하지 않는다. 상장폐지 종목은404로 조회되지 않아 별도 보완해야 한다.

`GET /api/v1/candles`에 `symbol`, `interval=1m`, `count=200`, `before`, `adjusted=false`를 사용하고 다음 페이지는 응답 `nextBefore`를 그대로 전달한다. 첫 표본은 실제 거래일인2026-05-04의 삼성전자 등으로 확인한다. 실제 응답·봉 시각·페이지 중복·공백을 검증한 뒤 전 종목으로 확대한다. 기존 사용자 인증과 공통 API 대기열을 사용하고 별도 토큰 발급·인증 우회를 만들지 않는다. 연구 수집은 운영 감시보다 낮은 우선순위로 진행한다.

국내 분봉은 KRX·NXT 통합이며0거래량 봉이 존재한다. 일봉과 분봉 거래량 합계는 집계 범위가 달라 일치하지 않을 수 있다. 기업행위·수정주가 처리도 저장해야 한다. `GET /api/v1/orderbook`에는 종목 외 과거 시각 인자가 없으며 최근 체결도 과거 방향 페이지네이션이 없다. 현재 호가를5월의 호가로 사용할 수 없다. 공식 이용 정책상 원시 시세는 공개 Git·블로그에 재배포하지 않는다.

## KRX 상품 선택·견적 확인용 범위

아래는 구체적인 요청 초안이며 발송한 문의가 아니다.

> 2026-05-01~2026-11-26 당시 유가증권시장 전체 종목의 개인 투자전략 백테스트용 자료를 확인하고자 합니다. 상장폐지 포함 날짜별 종목 목록·기본정보·거래정지/시장조치 이력,1분 OHLCV·거래대금, 호가장(가격·수량·단계·시각), 체결장(가격·수량·시각)의 제공 여부와 비용을 알려 주세요. ETF는 별도 구분이 필요합니다. 제공 기간,1일·소수 종목 표본, 파일 형식·시간대, 호가 단계 수, 원시 주문 이벤트인지 스냅샷인지, 기업행위 처리, 개인 연구·AI 분석 및 집계 결과 공개의 이용 조건도 확인하고 싶습니다. KRX와 별도로 NXT 자료를 제공하는지와 통합 재현 가능 여부도 확인 부탁드립니다.

주식 상품명은 **일중 매매정보·호가장·체결장**이다. ETF/ETN/ELW는 증권상품 목록에서 별도 선택한다. 상세 화면의 실제 응답은 로그인·회원가입 안내와 로그인 이동 코드였다. 금액과 특정 날짜의 주문 가능성을 추정하지 않는다. 공식 연락처는 krxdata@krx.co.kr,1577-0088 /02-3774-9000이며 연락하지 않았다.

KRX 단일 시장 자료와 토스의 KRX·NXT 통합 자료는 범위가 다르다. KRX 자료만 확보하면 결과를 KRX 기준 연구로 표시한다. 코스피 전체 종목을 코스피200 현재 구성종목으로 대체하지 않는다.

## X 접근과 비용

공식 `GET /2/tweets/search/all`에서 `from:elonmusk` 등 계정과 시작·종료 시각을 지정한다. `created_at`, `edit_history_tweet_ids` 등을 확인하고 현재 남은 글을 삭제·수정 전의 전체 당시 기록으로 간주하지 않는다. 조사 계정은 realDonaldTrump·elonmusk·KobeissiLetter이며 DeItaone은 본인 확인 대기다.

공식 가격표의 Posts Read는 반환 게시물당 USD0.005다. 게시물 읽기만 계산하면1,000건은 USD5,10,000건은 USD50이다. 사용자 정보 등 추가 자원·세금·환율은 제외했다. 최종 단가는 개발자 콘솔에서 확인하고 비용 상한을 정해야 한다. 결제·유료 호출은 하지 않았다. 공식 로그인 과정이 필요한 시점에 사용자에게 요청하며 키·비밀번호를 채팅에 요청하지 않는다.

## 연구 진행 순서와 현재 한계

1. 기존 토스 연결에서5월 분봉의 실제 응답·페이지네이션부터 검증한다.
2. 당시 전체 종목과 상장폐지 포함 범위를 확보하고 과거 전 종목 자료로 후보를 다시 계산한다. 당시 후보 목록 자체를 반드시 구매할 필요는 없다.
3. 확인된 분봉·공시·뉴스로 가격 기반 근사 연구는 가능하다. 분봉 안의 고저가 선후관계·지정가 대기열·5초 감시를 재현하지 못하는 한계를 기록한다. 호가를 가공해 실제 체결처럼 표시하지 않는다.
4. 현 `research/run.mjs`의 전체 전략 재현은 실제 과거 호가 등을 요구해 계속 blocked다. 분봉 연구에는 별도 실행 경로·가정·결과 표기를 구현해야 한다. 현재 실행기가 이미 지원한다고 소개하지 않는다.
5. 표본 효과가 확인된 기간·종목부터 호가·체결장 비용을 확인한다. 구매 승인 전 결제하지 않는다. 기간을 나눈 검증과 신규 모의 전진 검증 후 운영 변경 여부를 판단한다.

## 공식 출처

- [토스 FAQ: 제공 기간·상장폐지·통합 시세·이용 정책](https://openapi.tossinvest.com/openapi-docs/faq.md)
- [토스 캔들·호가 OpenAPI 명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)
- [KRX 주식 판매 상품](https://data.krx.co.kr/contents/MDC/DATA/datasale/index.cmd?viewNm=dataProdList&prodType=ST)
- [KRX 증권상품 판매 상품](https://data.krx.co.kr/contents/MDC/DATA/datasale/index.cmd?viewNm=dataProdList&prodType=EP)
- [KRX API 신청 순서](https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp)
- [KRX API 서비스 목록](https://openapi.krx.co.kr/contents/OPP/INFO/service/OPPINFO004.cmd)
- [유가증권 종목기본정보](https://openapi.krx.co.kr/contents/OPP/USES/service/OPPUSES002_S2.cmd?BO_ID=PiwgMdTwmsenXhmqqxuj)
- [DART 날짜별 코스피 공시](https://dart.fss.or.kr/dsac001/mainY.do?mdayCnt=0&selectDate=2026.05.04&currentPage=1)
- [OpenDART 가이드](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DE001&apiId=AE00001)
- [빅카인즈 서비스 안내](https://www.bigkinds.or.kr/v2/intro/service.do)
- [빅카인즈 FAQ](https://www.bigkinds.or.kr/news/faqList.do?page=2)
- [X 전체 기간 검색](https://docs.x.com/x-api/posts/search/quickstart/full-archive-search)
- [X 공식 가격표](https://docs.x.com/x-api/getting-started/pricing)
