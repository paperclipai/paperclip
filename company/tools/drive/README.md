# Drive Tools

이 폴더는 Google Drive 자료를 검색하고 읽기 위한 도구를 둔다.

핵심은 하나다.

`원본은 Drive에 두고, 필요한 순간에 찾아 읽는다.`

## 들어있는 도구

- [google_drive_oauth_bootstrap.py](./google_drive_oauth_bootstrap.py)
- [google_drive_cli.py](./google_drive_cli.py)

## 환경변수

루트 `.env`에 아래 값을 둔다.

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REFRESH_TOKEN`
- `GOOGLE_DRIVE_ROOT_ID`

## 가능한 작업

- 내 드라이브 파일 목록 보기
- 파일명 검색
- 파일 메타데이터 확인
- Google Docs를 텍스트로 export

## 예시

```bash
set -a; source /Users/bbright/Projects/company/.env; set +a

python3 /Users/bbright/Projects/company/tools/drive/google_drive_oauth_bootstrap.py
python3 /Users/bbright/Projects/company/tools/drive/google_drive_cli.py list
python3 /Users/bbright/Projects/company/tools/drive/google_drive_cli.py search --query "사업계획서"
python3 /Users/bbright/Projects/company/tools/drive/google_drive_cli.py export-text --file-id FILE_ID
```

## 한 줄 정리

이 도구는 대표가 Drive 자료를 빠르게 찾아 읽는 최소 운영 도구다.
