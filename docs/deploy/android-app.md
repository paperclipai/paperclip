---
title: Android App
summary: Install the Android dashboard app, pair it with a QR code, and reach Paperclip from outside your local network
---

The Android app is a native client for the Paperclip board. It uses the same `/api` routes as the web UI. The source is in `android/` in the repository.

It has these screens:

- Bottom tabs: Dashboard, Inbox, Tasks, Agents, Approvals.
- Side menu: Search, Decisions, Projects, Routines, Artifacts, Goals, Workspaces, Org chart, Skills, Connectors, Members, Costs, Activity, and Settings. The side menu also has the company switcher and shortcuts to projects and agents.

## 1. Build and install the app

There is no published APK yet. Build the app from source.

Requirements:

- JDK 17 or later
- The Android SDK with platform 36. Android Studio installs it.
- A phone with Android 8.0 (API 26) or later, with USB debugging turned on

Tell Gradle where the SDK is. Put `sdk.dir=/path/to/Android/Sdk` in `android/local.properties`, or set `ANDROID_HOME`.

Build and install the app:

```sh
cd android
./gradlew assembleDebug testDebugUnitTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 2. Prepare the server

The app needs a server in `authenticated` mode that the phone can reach. A server in `local_trusted` mode listens only on loopback. A phone can reach a `local_trusted` server only through USB forwarding (see [Option D](#option-d-usb-cable-development)).

You must have a board account on the web UI. On a new instance, sign up, then open the one-time `/board-claim/<token>?code=<code>` URL that the server prints at startup. See [Deployment Modes](/deploy/deployment-modes#board-claim-flow).

<Note>
The claim URL changes each time the server restarts. If the page says "Board claim challenge not found", copy the newest URL from the server log.
</Note>

## 3. Pair the phone with a QR code

1. In the web UI, open **Profile settings → Mobile app**.
2. Click **Pair a phone**. Paperclip creates a board API key named `Mobile app (<date>)`. The key expires in 90 days.
3. Read the **Server URL** under the code. The phone must be able to open this URL. Change it if necessary. The QR code updates when you change the URL.
4. On the phone, open the app and tap **Scan QR code**. You can also scan the code with the phone camera. The code holds a `paperclip://connect?url=...&key=...` link, and the camera opens the app.

The app connects and opens the dashboard. It keeps the key, so you stay connected after a restart.

To disconnect a phone, click **Revoke** next to that phone under **Paired devices**. To remove the key from the phone, use **Sign out** at the bottom of the side menu.

The sign-in screen also has other methods:

- **Email**: your web account email and password. Optionally paste a board claim URL to claim a new instance.
- **Board key**: paste a board API key.
- **Local**: use for a `local_trusted` server.

<Warning>
The QR code holds a key with full board access. Treat it like a password. Do not share a screenshot of it. Click **Hide code** when the phone is paired. If someone else sees the code, revoke the key.
</Warning>

## 4. Use the app when you are not on the same local network

A phone on mobile data, or on a different Wi-Fi network, cannot reach `http://192.168.x.x:3100`. Use one of these options.

| Option | Setup effort | Server stays private | Use it when |
| --- | --- | --- | --- |
| A. Tailscale | Low | Yes | Most people. This is the recommended option. |
| B. Other private VPN | Medium | Yes | You already use WireGuard, ZeroTier, or a similar VPN. |
| C. Public HTTPS URL | High | No | Other people must connect without a VPN. |
| D. USB cable | Low | Yes | Development and testing only. |

### Option A: Tailscale (recommended)

Tailscale puts the server and the phone on one private network. The network works from anywhere. You do not open ports on your router. The traffic is encrypted end to end.

1. Install Tailscale on the server machine and sign in.
2. Install the Tailscale app on the phone. Sign in with the same account.
3. Start Paperclip so that it listens on the Tailscale interface:

   ```sh
   pnpm dev --bind tailnet
   ```

   For more detail, see [Tailscale Private Access](/deploy/tailscale-private-access).
4. Pair the phone (step 3 above). If the server has a Tailscale address (`100.64.0.0/10`), the **Server URL** in the pairing panel uses it by default, for example `http://100.101.102.103:3100`.

Keep the Tailscale app connected on the phone. If the app cannot connect, open the Tailscale app and make sure it shows **Connected**.

To use the MagicDNS name (for example `http://my-pc.tailnet-name.ts.net:3100`) instead of the IP address, add it to the allowlist first:

```sh
npx paperclipai allowed-hostname my-pc.tailnet-name.ts.net
```

Then restart Paperclip. Type the name into the **Server URL** field before you scan.

### Option B: Another private VPN

WireGuard, ZeroTier, NetBird, and similar VPNs work like Tailscale.

1. Connect the server and the phone to the VPN.
2. Start Paperclip with `pnpm dev --bind lan` so that it listens on all private interfaces.
3. If you use a hostname, add it with `npx paperclipai allowed-hostname <hostname>`, then restart Paperclip.
4. In the pairing panel, set **Server URL** to the VPN address of the server, for example `http://10.8.0.1:3100`. Then scan.

### Option C: A public HTTPS URL

Use this option only if you must reach Paperclip without a VPN. The login page is then on the public internet.

1. Run Paperclip in `authenticated` + `public` mode. See [Deployment Modes](/deploy/deployment-modes).
2. Put an HTTPS endpoint in front of port `3100`. Use a reverse proxy with a TLS certificate (Caddy, nginx, Traefik), or use a tunnel (Cloudflare Tunnel, ngrok).
3. Set the public URL, then restart Paperclip:

   ```sh
   PAPERCLIP_PUBLIC_URL=https://paperclip.example.com
   ```

4. Pair the phone. When the server has no Tailscale address, the **Server URL** is the public URL.

<Warning>
Always use HTTPS for a public URL. Do not forward port `3100` on your router to plain HTTP. The app sends the board key with each request, so plain HTTP exposes the key on every network the request crosses. Use a strong password, and revoke paired phones that you no longer use.
</Warning>

### Option D: USB cable (development)

Connect the phone with a USB cable and forward the port:

```sh
adb reverse tcp:3100 tcp:3100
```

In the app, use `http://localhost:3100`. This works only while the cable is connected. You must run the command again after you reconnect the cable.

## Troubleshooting

- **The app shows a connection error.** Open the server URL plus `/api/health` in the phone browser. If the browser cannot load it, the phone cannot reach the server. Check the VPN connection, the `--bind` setting, and the port.
- **"That QR code is not a Paperclip pairing code."** You scanned a different code. Scan the code in **Profile settings → Mobile app**.
- **The pairing panel shows a `localhost` warning.** The phone cannot use `localhost`. Change **Server URL** to an address that the phone can reach, then scan.
- **The app signs out after some months.** The paired key expired after 90 days. Pair the phone again.
- **Login or redirect errors when you use a hostname.** Add the hostname with `npx paperclipai allowed-hostname <hostname>`, then restart Paperclip.
- **An Android emulator cannot reach the server.** In the emulator, use `http://10.0.2.2:3100` to reach port `3100` on the host machine.

## Security notes

- A paired phone has full board access. It can approve, reject, pause agents, and change settings.
- The app stores the key in its private app storage. Other apps cannot read it. The key is not encrypted on disk.
- Each paired phone has its own key. Revoke one phone without affecting the others.
- The app allows plain HTTP because private networks such as Tailscale often use it. Tailscale and WireGuard encrypt the traffic themselves. On any other network, use HTTPS.
