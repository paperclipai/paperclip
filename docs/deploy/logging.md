---
title: Logging and Rotation
summary: Server log retention and rotation for Paperclip instances
---

Paperclip writes server logs to:

- `/home/paperclip/.paperclip/instances/default/logs/server.log`

To prevent unbounded growth, install the committed logrotate policy:

```sh
sudo ./scripts/install-paperclip-logrotate.sh
```

This installs `/etc/logrotate.d/paperclip` with:

- daily rotation
- 7 retained archives
- 100 MB size cap
- `copytruncate`
- `compress` + `delaycompress`

Validate manually if needed:

```sh
sudo logrotate -d /etc/logrotate.d/paperclip
```
