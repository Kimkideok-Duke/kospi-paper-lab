# 2026-11-27 개발기 도식 제작 정보

- 용도: 11월27일 개발기의 운영·연구 경계 설명. Velog 대표 이미지는 별도의 제목 표지로 제작해 같은 그림을 본문에 반복하지 않는다.
- 원본: `marketlab-2026-11-27-verification.svg` (1280×760). 정밀 설명을 위해 코드로 직접 제작했다. 생성형 이미지 모델은 사용하지 않았다.
- 배포용: `marketlab-2026-11-27-verification.png` (2560×1520). Windows System.Drawing과 맑은 고딕으로 렌더링했다.
- 재현: 이 폴더의 `render-2026-11-27-diagram.ps1` 실행.
- 별도 표지: `marketlab-2026-11-27-cover.svg`(1280×720)와 같은 이름의 PNG(2560×1440). `render-2026-11-27-diagram.ps1 -ImageName marketlab-2026-11-27-cover`로 제작했다. 표지는 세 주제를 소개하고 본문 도식은 실제 구조를 설명한다.
- 근거: `server/paper-model.mjs`, `server/day-chart-review.mjs`, `server/local-research.mjs`, `research/evidence.mjs`, `research/replay.mjs`의 실제 구조. 독립 재현 실행기는 구현됐지만 필요한 역사 자료가 부족하면 중단하며 운영 자동 승격은 하지 않는다.
- 출처·권리: 프로젝트용 자체 제작 도식. 제3자 사진·아이콘·로고를 사용하지 않았다. 시스템 글꼴 파일은 포함하지 않는다.
- 실제 사용자·계좌·매매·가격·수익률 자료는 포함하지 않는다. 그림은 성과나 실제 거래소 체결 재현 완료를 나타내지 않는다.
- 공개 확인: [11월27일 개발기](https://velog.io/@kkd9013/marketlab-devlog-2026-11-27)의 대표 표지는 Velog 정식 업로드, 본문 도식은 저장소 공개 PNG 주소를 사용했다. 게시 후 브라우저에서 각각2560×1440·2560×1520 크기와 로딩 성공을 확인했다. 인증 없는 글 조회에도 두 이미지 주소가 포함됐다.
