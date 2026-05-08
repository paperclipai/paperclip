# AWS SSM environment driver

The SSM environment driver runs Paperclip workloads on EC2 hosts **without exposing
sshd to the network**. It tunnels OpenSSH through `aws ssm start-session
--document-name AWS-StartSSHSession`, so the EC2 instance only needs the SSM
agent running and an outbound path to AWS Systems Manager — no security group
ingress for port 22.

Architecturally, the SSM driver reuses the SSH driver's full execution path
(workspace `tar | ssh` sync, login-profile sourcing, command exec). The only
delta is an OpenSSH `ProxyCommand` populated at runtime from your AWS region,
optional profile, and a tag-resolved instance ID.

## Prerequisites

### On the Paperclip host (where the orchestrator runs)

1. **AWS CLI v2** on the system PATH. Verify with `aws --version`. Install: see
   https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
2. **Session Manager plugin** on the system PATH. Verify with
   `session-manager-plugin --version`. Install: see
   https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
3. **AWS credentials** resolvable via the standard AWS CLI chain. The driver
   uses the AWS SDK's default provider chain — exactly like the AWS CLI:
   - When Paperclip runs on EC2 with an IAM instance role, that role is used
     automatically (no env vars or config needed).
   - When Paperclip runs locally, the chain falls through env vars
     (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`), then the profile named in
     `AWS_PROFILE`, then the `[default]` profile in `~/.aws/credentials`.
   - You can pin a specific profile per environment via the **AWS profile**
     field — when set it overrides the chain for that environment only.

### On the target EC2 instance

1. **SSM agent** installed and running. Most Amazon-published AMIs bundle it.
   Verify with `sudo systemctl status amazon-ssm-agent`.
2. **Instance role** with `AmazonSSMManagedInstanceCore` (managed AWS policy)
   attached. Without this, the instance does not register with SSM and tag
   resolution returns zero matches.
3. **sshd running**. Bind it to `127.0.0.1` if you do not need any external
   SSH access — the SSM tunnel reaches sshd via loopback. (`ListenAddress
   127.0.0.1` in `/etc/ssh/sshd_config`.)
4. **Authorized key**. Add the public half of the private key you'll paste
   into the Paperclip UI to `~/<username>/.ssh/authorized_keys` (or use SSM
   Run Command to seed it as part of host bootstrap).
5. **Tag the instance** with the key/value pair you'll use in Paperclip — for
   example `Paperclip=runner-prod`. The tag value must match exactly one
   online SSM-managed instance.

### IAM permissions on the orchestrator side

The credentials Paperclip uses need at minimum:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:DescribeInstanceInformation",
        "ssm:StartSession",
        "ssm:TerminateSession",
        "ssm:ResumeSession"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:StartSession",
      "Resource": "arn:aws:ssm:*:*:document/AWS-StartSSHSession"
    }
  ]
}
```

In production, scope `Resource` further by region, account, or instance tag —
e.g. `arn:aws:ec2:us-east-1:123456789012:instance/*` with a tag-based
`Condition` block.

## Configuring an SSM environment in Paperclip

1. **Settings → Environments → Add environment**.
2. Set **Driver** to `SSM (AWS Systems Manager)`.
3. Fill in:
   - **AWS region** (e.g. `us-east-1`).
   - **AWS profile** — leave blank to use the default credentials chain.
   - **Tag key** / **Tag value** matching exactly one online instance.
   - **Username** — the SSH login user (e.g. `ec2-user`, `ubuntu`).
   - **Port** — sshd port; defaults to 22.
   - **Remote workspace path** — absolute path Paperclip's workspace sync writes
     into.
   - **Private key** — paste the PEM key (it gets stored in the secret store
     and removed from the config), or pick a previously-stored secret.
   - **Known hosts** / **Strict host key checking** — same semantics as the
     SSH driver. Strict checking is enforced on top of the SSM tunnel.
4. Click **Test connection**. The probe runs `aws ssm
   start-session` against the resolved instance ID and verifies the remote
   workspace path exists.

## Troubleshooting

- **"aws CLI is not installed or not on PATH"** — install AWS CLI v2 on the
  Paperclip host (see prereqs).
- **"session-manager-plugin is not installed or not on PATH"** — install the
  Session Manager plugin (see prereqs).
- **"No online SSM-managed instance matches tag X=Y"** — verify the EC2
  instance has the tag, has the `AmazonSSMManagedInstanceCore` policy, and
  shows up in `aws ssm describe-instance-information --filters
  "Key=tag:X,Values=Y" "Key=PingStatus,Values=Online"`.
- **"Multiple SSM-managed instances match tag X=Y"** — narrow the tag value
  so it points at a single host.
- **OpenSSH fails inside the tunnel** — re-check sshd is running on the
  instance, the username is correct, and the public key is in the correct
  user's `authorized_keys`.

## How it differs from the SSH driver

| | SSH driver | SSM driver |
|---|---|---|
| Network exposure | Requires open port 22 | None — SSM agent is outbound-only |
| Authentication | SSH key | SSH key + IAM (for SSM tunnel) |
| Host identity | DNS or IP | Tag → resolved instance ID |
| Workspace sync | `tar \| ssh` | `tar \| ssh` (over SSM tunnel) |
| Probe connectivity | Direct TCP | `aws ssm start-session` ProxyCommand |
| Per-call latency | TCP RTT | TCP RTT + SSM agent hop (~50ms) |
