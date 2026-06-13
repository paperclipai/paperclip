---
title: 利用 Tailscale 进行私有组网访问
summary: 让运行时的 Paperclip 对 Tailscale 组网的 host 进行友好绑定，以支持外部的别处设备接入控制面板
---

这是当您希望跨过限制极大的 `localhost` 锁区，借助使用类似 Tailscale（或是别的某个私密局域网 LAN/VPN 环境）在远端网络对家中的 Paperclip 进行远程监工遥控时的必备操作指南。

## 1. 以“私有验证模式”来启动 Paperclip

```sh
pnpm dev --tailscale-auth
```

这是一条组合式的快捷底层配置宏，它实际上一口气替你在内部配置好了：

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated` （进入身份验证控制态配置）
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private` （表明它现在属于内部私有域的对外暴露资产）
- `PAPERCLIP_AUTH_BASE_URL_MODE=auto` （支持动态探测环境自动分发获取正确的对外 base URL 地址参数）
- `HOST=0.0.0.0` (使得服务器放开警戒允许绑定在全部的网络大门上准备迎接接纳外部流量)

其等效的别称命令为：

```sh
pnpm dev --authenticated-private
```

## 2. 找到您能够用来连入的有效的 Tailscale 对外暴露专线地址

回到当前那台运行了 Paperclip 服务端的机子主网络环境终端去，键入：

```sh
tailscale ip -4
```

当然了，如果你懒得记那一串干瘪的数字 IP，也可以直接套用属于您的 Tailscale MagicDNS 下所指派的长效直观主机名（比如类似于：`my-macbook.tailnet.ts.net`）。

## 3. 从任意别的远程设备上直接敲门拉开 Paperclip 图形面板！

拼装套用刚才你记下的那个 Tailscale 专属 IP 或 MagicDNS 名字，并在结尾挂上属于 Paperclip 所在的专用监听端口：

```txt
http://<tailscale-host-or-ip>:3100
```

实战案例：

```txt
http://my-macbook.tailnet.ts.net:3100
```

## 4. (按需操作) 给非常规自定的私有主机名字主动开白名单放行通过

如果您执意使用了一个非标准自命名的冷门花式私有本地 hostname 去访问 Paperclip 如果被系统后台拦下，您应当及时为它大声澄清并录入系统的允许接纳白名单里面：

```sh
pnpm paperclipai allowed-hostname my-macbook.tailnet.ts.net
```

## 5. 最后确认远端服务机连通无死角

找另外一台正开着连结至同一条 Tailscale 私有内网信道的远程遥控终端，在黑框指令处主动跑一下去主动发起查验证实请求：

```sh
curl http://<tailscale-host-or-ip>:3100/api/health
```

如果通了，它会乖乖吐出这个预期的回应给你：

```json
{"status":"ok"}
```

## 杂症常见故障排查问诊 (Troubleshooting)

- 出现奇奇怪怪登录不了或者在这个自定义私有主机网关上陷入诡异的不断重定向大回环死循环：请果断再次尝试将这个长域网名通过 `paperclipai allowed-hostname` 命令正式上表天听给开具录入绿色同行认证白名单里。
- 发觉这网页后端这门生意死活只能紧紧龟缩捆在本地本机 `localhost` 底下玩自嗨：确认你起服的时候确实不折不扣把附带指令加上敲全了启动的带有 `--tailscale-auth` flag 开关（或是你真切在私有形态配置文件下加塞写进了 `HOST=0.0.0.0` 这个字段参数）。
- 可以本地本机自嗨访问，却遥遥阻断被外边另一头的远程给死活接连不进来：去反反复复重新检查你这两只终端两头这是否确凿铁定无误地确已组队进了**同一个所属**的这个 Tailscale VPN 内网鱼笼环境大网段里，同时还要额外排查是否是因为这倒霉的 `3100` 号对应端口被中间拦截墙/安全组意外截获拦截不许放权经过通过。
