# Setup Tools

이 폴더는 새 컴퓨터나 새 작업 환경에서 company repo를 바로 쓸 수 있게 만드는 초기 설정 도구를 보관한다.

## 스킬 연결

다른 컴퓨터에서 이 repo를 pull 받은 뒤, 아래 명령을 한 번 실행한다.

```bash
./tools/setup/mycompany-install-skills
```

이 명령은 repo 안의 아래 경로를 해당 컴퓨터의 홈 디렉터리 스킬 경로에 연결한다.

- `.agents/skills`
- `.codex/skills`

즉, 앞으로는 `company repo`가 스킬 원본이 되고, 각 컴퓨터는 이 repo를 바라보게 된다.

## 운영 원칙

- 스킬 수정은 repo 안에서 한다
- 새 컴퓨터에서는 pull 후 위 명령만 다시 실행한다
- 기존 홈 디렉터리 스킬 폴더가 있으면 자동으로 backup을 만든다
