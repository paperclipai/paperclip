COS v2 개발 환경을 자동으로 셋업합니다.

## 순서대로 실행:

1. `pnpm install` 실행
2. `pnpm --filter @paperclipai/shared build` 실행
3. `pnpm --filter @paperclipai/db build` 실행  
4. `pnpm --filter @paperclipai/plugin-sdk build` 실행
5. `~/.paperclip/instances/default/` 디렉토리 생성 (없으면)
6. `company/private-data/env/cos-v2.env` 파일에서 DATABASE_URL 읽기. 파일이 없으면 사용자에게 DATABASE_URL 물어보기.
7. `~/.paperclip/instances/default/config.json` 파일 생성 또는 업데이트:
   - 이미 있으면 `database.url`만 업데이트
   - 없으면 아래 템플릿으로 생성 (HOME 경로는 실제 값으로 치환):
```json
{
  "$meta": { "version": 1, "source": "cos-v2-setup" },
  "database": { "mode": "external", "url": "<DATABASE_URL>" },
  "server": { "deploymentMode": "local_trusted", "exposure": "private", "host": "127.0.0.1", "port": 3101, "serveUi": true },
  "auth": { "baseUrlMode": "auto" },
  "storage": { "provider": "local_disk", "localDisk": { "baseDir": "<HOME>/.paperclip/instances/default/data/storage" } },
  "secrets": { "provider": "local_encrypted", "strictMode": false, "localEncrypted": { "keyFilePath": "<HOME>/.paperclip/instances/default/secrets/master.key" } }
}
```
8. `.env` 파일에 `PORT=3101` 쓰기 (없으면)
9. `pnpm --filter @paperclipai/db migrate` 실행
10. `PORT=3101 pnpm dev` 로 서버 시작
11. `curl http://127.0.0.1:3101/api/health` 로 health 확인
12. 완료 메시지: `http://127.0.0.1:3101` 안내
