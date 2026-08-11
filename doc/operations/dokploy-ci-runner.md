# Dokploy CI runner

`Provision Dokploy CI runner` creates a private repository-scoped GitHub
Actions runner named `paperclip-dokploy-ci-1` in the `paperclip-ci` Dokploy
project. It accepts only jobs requesting these labels:

```yaml
runs-on: [self-hosted, linux, x64, paperclip-ci]
```

Run `.github/workflows/provision-dokploy-ci-runner.yml` manually to create or
repair the service. The bootstrap workflow uses the existing
`DOKPLOY_API_KEY` GitHub secret plus `PAPERCLIP_RUNNER_ADMIN_TOKEN`, a
fine-grained PAT restricted to this repository with Administration read/write
permission. The PAT mints a short-lived GitHub runner registration token; that
short-lived token is removed from the runner process after registration and the
runner's registration state/workspace persist in named volumes.

Only trusted `push` workflows for this repository may use the runner. Do not
route fork pull requests, `pull_request_target`, or Docker-socket jobs to it.
Keep deployment jobs GitHub-hosted so deploy credentials remain isolated from
repository code that runs on the self-hosted worker.
