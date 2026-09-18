# 🎉 리듬게임파티!!

카메라 앞에서 몸을 움직여 즐기는 랜덤 리듬게임 모음 MVP.

## 현재 포함된 기능

- GitHub Pages용 정적 사이트
- 브라우저 카메라 입력
- MediaPipe Tasks Vision 기반 포즈/손 랜드마크 추적
- 스테이지마다 미니게임 랜덤 선택
- 스테이지가 올라갈수록 BPM/노트 밀도 증가
- HP 5칸 + 콤보 + 점수
- PERFECT / GREAT / GOOD / MISS 판정
- 게임 결과 / 스테이지 결과 / 게임 오버 화면
- 최고 스테이지 / 최고 점수 localStorage 저장
- 외부 음원 없이 Web Audio 효과음 사용
- 반응형 UI

## 미니게임

1. 👋 손 흔들기
2. 🥊 펀치 마스터
3. 🎯 타겟 터치
4. ↔️ 좌우 피하기

Stage 1~2는 2개, Stage 3~5는 3개, Stage 6부터는 4개의 게임이 선택됩니다.

## 실행

가장 간단한 방법은 GitHub에 올리고 GitHub Pages를 켜는 것입니다.

로컬 테스트는 정적 서버를 사용하세요.

```bash
python -m http.server 8000
```

그리고 `http://localhost:8000` 접속.

카메라 권한 때문에 `file://`로 직접 여는 것보다 localhost 또는 HTTPS가 좋습니다.

## GitHub Pages

1. 이 폴더를 GitHub 저장소의 루트에 업로드
2. GitHub 저장소의 **Settings → Pages**로 이동
3. **Source = GitHub Actions** 또는 branch 기반 배포 선택
4. 아래에 포함된 `.github/workflows/pages.yml`을 사용하면 main push 시 자동 배포

프로젝트 사이트 주소는 일반적으로 `https://<username>.github.io/<repository>/` 형태입니다.

## 구조

```text
rhythm-game-party/
├─ index.html
├─ README.md
├─ css/
│  └─ style.css
├─ js/
│  └─ main.js
└─ .github/
   └─ workflows/
      └─ pages.yml
```

## 참고

MediaPipe Tasks Vision 1.0.1을 CDN에서 불러옵니다. 모델도 Google의 MediaPipe 모델 저장소에서 브라우저가 직접 받아옵니다. 실제 배포 시 CDN/모델 URL에 변화가 생기면 `js/main.js`의 버전을 업데이트하세요.

### 다음 개발 후보

- 실제 노래/곡별 BPM 패턴 추가
- 게임별 난이도 곡선 세분화
- FEVER / RANDOM EVENT 시스템
- 더 다양한 포즈 기반 미니게임
- 손/몸 움직임 판정 튜닝
- 모바일/저사양 기기 최적화
- 게임별 랭크/기록 화면
