# Running Paperclip as an OS Service

The `paperclipai service` command lets you install and manage Paperclip as a persistent background service that survives reboots and process restarts.

## Supported platforms

| Platform | Backend | Unit location |
|----------|---------|---------------|
| macOS | launchd | `~/Library/LaunchAgents/com.paperclipai.paperclip.plist` |
| Linux | systemd (user) | `~/.config/systemd/user/paperclip.service` |

Windows is not currently supported.

## Install

```bash
paperclipai service install
```

This generates the appropriate service unit file for your OS, installs it, and starts the service immediately. Logs are written to `~/.paperclip/logs/service.log`.

## Manage

```bash
# Check if the service is running
paperclipai service status

# Stop the service
paperclipai service stop

# Start the service
paperclipai service start

# Restart the service
paperclipai service restart

# View recent logs (last 50 lines)
paperclipai service logs

# Follow logs in real time
paperclipai service logs --follow

# Show more lines
paperclipai service logs -n 200
```

## Uninstall

```bash
paperclipai service uninstall
```

This stops the service and removes the unit file. Your Paperclip data and configuration are not affected.

## macOS details

The launchd plist is configured with:

- **KeepAlive**: `true` — launchd restarts the process if it exits
- **RunAtLoad**: `true` — starts automatically on login
- **ThrottleInterval**: `10` — waits 10 seconds before restarting a crashed process

To inspect the raw plist: `cat ~/Library/LaunchAgents/com.paperclipai.paperclip.plist`

To check launchd status directly: `launchctl list com.paperclipai.paperclip`

## Linux details

The systemd user unit is configured with:

- **Restart**: `always` — systemd restarts the process on any exit
- **RestartSec**: `10` — 10-second delay before restart
- **WantedBy**: `default.target` — starts on user login

To inspect the unit file: `cat ~/.config/systemd/user/paperclip.service`

To check systemd status directly: `systemctl --user status paperclip.service`

To view systemd journal logs: `journalctl --user -u paperclip.service`

> **Note**: For systemd user services to run without an active login session, enable lingering: `loginctl enable-linger $USER`

## Upgrading

After upgrading Paperclip (e.g., `npm install -g paperclipai`), re-run the install command to update the service unit with the new server path:

```
paperclipai service install
```

The install command handles the existing service gracefully (bootout + re-bootstrap on macOS, disable + re-enable on Linux).
