# HEARTBEAT — QA

Frequência:
- Execução nightly; runs ad-hoc em PRs; alertas imediatos em falhas de smoke.

Payload exemplo:
{"agent":"qa","last_run":"ISO","status":"green|red|flaky","failed_tests":[]}
