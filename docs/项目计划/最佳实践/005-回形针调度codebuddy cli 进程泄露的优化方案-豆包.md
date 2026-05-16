我用回形针调度codebuddy的无头模式 会搞很多node进程出来 然后cpu狂转 怎么办

先给结论：**你现在的问题就是：无头模式 + 回形针调度 → 每次任务都新开 node 进程、又不回收 → 进程泄漏 + 死循环 / 轮询 → CPU 狂转**。下面直接给可落地的排查 + 解决步骤（从快到狠）。

---

## 一、先确认是不是 “进程泄漏”

在跑任务时开终端 / 任务管理器看：

### Windows

plaintext

```plaintext
tasklist | findstr node
```

看 node 数量是不是越跑越多、不下降。

### macOS/Linux

plaintext

```plaintext
ps aux | grep node | wc -l
```

一直涨 → 就是**进程没回收**。

再看 CPU：

plaintext

```plaintext
top
```

一堆 node 各占十几 / 几十 % → 典型。

---

## 二、立刻止血（马上见效）

### 1）先把所有僵尸 node 杀掉

Windows（管理员）：

plaintext

```plaintext
taskkill /F /IM node.exe
```

macOS/Linux：

plaintext

```plaintext
pkill -f node
```

### 2）回形针调度先改成**串行 + 单实例**

核心：**不要每次任务都新建 codebuddy 无头实例**。

- 改成：**全局只启 1 个 codebuddy 无头进程，任务排队跑**
- 回形针那边：并发数设为 **1**，不要 “每个请求 / 每个文件都起一个”

---

## 三、codebuddy 无头模式本身的坑（最常见）

### 现象

无头模式下，很多 AI 工具 / 插件会：

- 启动后**死循环轮询**（查文件、查配置、查更新）
- 没有正常退出逻辑 → 任务结束 node 不退出
- 多实例一起跑 → 每个都占 CPU、抢文件监听

### 解决（必须做）

1. **禁止 codebuddy 自启动多进程 / 多 worker**
    
    找它的配置（settings.json/config.js/ 启动参数）：
    
    - 把 `worker: true` / `multiProcess` / `concurrency` 改成 **1 或 false**
    - 无头模式启动命令，**不要加任何并发 / 多实例参数**
2. **禁用文件监听 / 自动索引（最杀 CPU）**
    
    很多 AI 插件无头模式也会监听整个目录：
    
    plaintext
    
    ```plaintext
    --no-watch
    --disable-file-watcher
    --exclude node_modules,.git,dist
    ```
    
    能加的都加上。
    
3. **限制 node 本身 CPU / 内存（防止狂转）**
    
    Linux/macOS 启动时加（绑到 1–2 核，降优先级）：
    
    plaintext
    
    ```plaintext
    taskset -c 0,1 nice -n 10 node codebuddy-headless.js
    ```
    
    Windows 用任务管理器→详细信息→右键 node→设置相关性（只勾 1–2 核）。
    

---

## 四、回形针调度侧的正确写法（避免 “进程爆炸”）

你现在大概率是：**每来一个任务 → spawn 一个 node codebuddy → 跑完不 kill**。

### 正确做法（伪代码思路）

js

```js
// 全局只开 1 个无头实例，复用
const cp = require('child_process');
let codebuddy = cp.spawn('node', ['codebuddy-headless.js'], {
  stdio: 'pipe'
});

// 任务排队，串行发指令，不要多开
function runTask(task) {
  return new Promise(resolve => {
    codebuddy.stdin.write(JSON.stringify(task)+'\n');
    codebuddy.stdout.once('data', d => resolve(d));
  });
}

// 回形针调度：并发=1，排队执行
```

关键点：**复用进程，不重复 spawn**。

---

## 五、终极兜底：用 cgroup/ulimit 限制进程数（防止炸机）

### Linux（临时）

plaintext

```plaintext
# 限制当前用户最多 20 个进程
ulimit -u 20
```

### 容器 / 长期

用 cgroup 把 codebuddy 这一组的：

- pids.max = 5（最多 5 个 node）
- cpu.cfs_quota_us 限制 CPU 占比

---

## 六、你现在优先做的 3 件事（按顺序）

1. **杀掉所有 node 进程** → 先降 CPU
2. **回形针并发改成 1，全局只跑 1 个 codebuddy 无头实例**
3. **codebuddy 无头启动加：--no-watch --disable-file-watcher，关闭多 worker**

做完这三步，基本能从 “几十个 node、CPU 100%” 降到 “1 个 node、CPU 正常”。

---

如果你愿意，我可以帮你：

- 看你现在回形针调度的配置 / 脚本 → 直接改成 “单实例复用版”
- 给你一份 codebuddy 无头模式**最优启动参数**（直接复制用）

要不要我帮你改脚本？你把调度那一段贴出来就行。

参考 18 篇资料

如何避免回形针调度codebuddy时产生僵尸进程？

# 回形针调度 CodeBuddy 无头 彻底杜绝僵尸 Node 进程 + CPU 狂飙 终极方案

核心病根：**子进程 spawn 后不监听退出、不手动销毁、回形针频繁新建实例不复用 → 孤儿进程 / 僵尸进程堆积、轮询空转吃 CPU**

下面给你**可直接照搬的规范写法 + 回形针配置 + 兜底防护**，一次性解决。

## 一、核心原则（必须遵守）

1. **绝不每次任务都新建 CodeBuddy 无头进程**，全局**单进程常驻复用**
2. 所有 `child_process.spawn/exec` **必须监听 close/exit/error**，回收句柄
3. 任务结束**主动发信号杀死子进程**，不放任后台挂着
4. 禁止 CodeBuddy 无头开启文件监听、后台轮询、多 Worker

## 二、标准安全写法（无僵尸进程模板）

### 1. 错误写法（你现在中招的写法）

每次调度都新开，不回收，必炸僵尸：

js

```js
// 错误：每次任务都spawn，不监听、不销毁
cp.spawn("node", ["codebuddy-headless"]);
```

### 2. 正确安全写法（常驻单例 + 自动回收）

javascript

运行

```javascript
const { spawn } = require('child_process');

// 全局常驻唯一实例
let cbProcess = null;

// 启动常驻CodeBuddy无头
function startCodeBuddy() {
  if (cbProcess) return cbProcess;

  cbProcess = spawn('node', [
    'codebuddy-headless',
    '--no-watch',      // 关闭文件监听
    '--no-daemon'      // 关闭后台守护
  ], {
    shell: false,
    stdio: 'pipe'
  });

  // 关键：监听所有退出事件，彻底防僵尸
  cbProcess.on('close', (code) => {
    console.log('CodeBuddy进程退出', code);
    cbProcess = null; // 清空引用
  });

  cbProcess.on('error', (err) => {
    console.error('进程异常', err);
    safeKill();
  });

  return cbProcess;
}

// 安全销毁进程（手动清理防僵尸）
function safeKill() {
  if (cbProcess && !cbProcess.killed) {
    // 先温柔退出，超时强制杀
    cbProcess.kill('SIGTERM');
    setTimeout(() => {
      if (cbProcess && !cbProcess.killed) {
        cbProcess.kill('SIGKILL');
      }
    }, 3000);
    cbProcess = null;
  }
}

// 进程意外退出自动重启
setInterval(() => {
  if (!cbProcess) startCodeBuddy();
}, 10000);
```

关键点：

- 只启动**一个常驻进程**，任务复用
- 监听 `close/error` 清空引用
- 提供 `safeKill` 优雅终止，避免孤儿进程

## 三、回形针调度关键配置（最关键）

1. **调度并发数设为 1**
    
    不要多任务同时拉起多个 CodeBuddy，排队串行执行
2. **关闭任务独立进程模式**
    
    回形针里不要勾选「每次任务新开独立进程」
3. **任务执行完毕强制回调销毁**
    
    回形针流程末尾加脚本：调用 `safeKill` 兜底清理，不残留

## 四、CodeBuddy 无头启动必加参数（防空转 CPU）

启动时强制加这几个，禁止后台轮询、文件监听、自动索引：

bash

运行

```bash
node codebuddy-headless \
  --no-watch \
  --disable-file-watcher \
  --no-auto-update \
  --single-worker
```

作用：杜绝无头模式后台死循环轮询，从源头降 CPU、不衍生子进程。

## 五、兜底机制：自动查杀僵尸 Node 进程

### Windows 定时清理

建个定时任务，每隔 5 分钟执行：

cmd

```cmd
tasklist | findstr node.exe | findstr /v "有用的主进程"
taskkill /F /IM node.exe
```

### Linux/Mac 一行定时清僵尸

bash

运行

```bash
# 杀掉所有脱离终端、僵尸化的node
pkill -f "codebuddy-headless"
```

## 六、快速自检判断是否还有僵尸

Windows：

cmd

```cmd
tasklist | findstr node
```

Linux/Mac：

bash

运行

```bash
ps aux | grep node
```

正常应该**只有 1 个 node 进程**，数量不上涨、不凭空新增，就是解决了。

## 七、一句话总结根治方案

1. 改代码：**全局单例常驻 CodeBuddy，不复辟新建**
2. 加监听：必绑 `close/error`，手动优雅杀进程
3. 回形针：并发 = 1，禁用每任务独立进程
4. 启动加参数：关监听、关守护、单 Worker
5. 定时兜底：定期查杀残留僵尸 Node

你把你现在**回形针调用 CodeBuddy 的那一段脚本**发给我，我可以直接给你改成无僵尸、不炸 CPU 的成品版本，直接替换就能用。