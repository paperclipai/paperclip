# Stack Lab — Episode 1 Script v5
**Title:** 3 Fixes That Cut Your CI Build from 8 Minutes to 72 Seconds  
**Issue:** TSM-5973 | **Date:** 2026-08-01 | **Audience:** Working software engineers, mid-level  
**Target runtime:** ~13 minutes | **Voice:** Charon (Sam)  
**Pacing notation:** `[PAUSE Xs]` = authored silence; TTS must honour these — do not strip  
**Pronunciation notation:** `(pr: "...")` = IPA-free phonetic guide for the TTS pronunciation dictionary

---

## PRONUNCIATION DICTIONARY — apply before TTS render (full term sweep)

| Term | Correct | Wrong (flag/reject) |
|---|---|---|
| Docker | "dock-er" | "dook-er", "dock-ur" |
| Dockerfile | "dock-er file" | "dook-er file" |
| npm | "N-P-M" (three letters) | "num", "num-pee-em" |
| YAML | "yam-ul" | "ya-mel", "yam-ul" ✓ |
| SHA | "shah" (one syllable) | "shaw", "shuh" |
| package-lock.json | "package lock dot jay-son" | "package lock dot json" |
| BuildKit | "build-kit" | "build-keet" |
| CI | "C-I" (two letters) | "see-eye" ✓ |
| ghcr.io | "G-H-C-R dot eye-oh" | "gee-hee-see-ar" |
| devDependencies | "dev deh-pen-den-seez" | — |
| hashFiles | "hash files" | "hash-files" |
| lockfile | "lock file" | — |
| GitHub Actions | "git-hub ack-shuns" | — |
| COPY (Dockerfile instruction) | "copy" | — |
| restore-keys | "restore keys" | — |
| ubuntu-latest | "oo-bun-too lay-test" | — |

---

## SCRIPT

---

### SECTION 1 — HOOK (0:00–0:30)

Every push you make kicks off this whole pipeline. [PAUSE 0.8s] The real question is — how long are you sitting here waiting for it? [PAUSE 1.2s]

Eight minutes. [PAUSE 0.5s] Forty-two seconds. [PAUSE 0.8s] That is how long this build takes, on every single push. [PAUSE 0.8s] Node project, three-stage GitHub Actions (pr: "git-hub ack-shuns") pipeline, one Docker (pr: "dock-er") image. [PAUSE 0.8s] Numbers you will see on screen exactly as I say them. [PAUSE 1.5s]

By the end of this, three changes — nothing you need to install, nothing new to maintain — cut that to seventy-two seconds. [PAUSE 0.8s] Let me show you where the time goes, and what you change to stop paying for it. [PAUSE 2.0s]

---

### SECTION 2 — WHERE THE TIME GOES (0:30–2:00)

Here is the GitHub Actions (pr: "git-hub ack-shuns") timeline for that build. [PAUSE 0.8s]

Three stages. [PAUSE 0.8s] npm (pr: "N-P-M") install: two minutes, seventeen seconds. [PAUSE 0.8s] Docker (pr: "dock-er") build: five minutes, nine seconds. [PAUSE 0.8s] Test run: one minute, sixteen seconds. [PAUSE 1.5s]

The npm (pr: "N-P-M") install and the Docker (pr: "dock-er") build together eat seven and a half minutes of that eight forty-two. [PAUSE 0.8s] Those are also the two that did not need to run at full cost. [PAUSE 1.5s]

Here is why. [PAUSE 0.8s] Your CI runner has no memory between builds. [PAUSE 0.8s] It does not know your package-lock.json (pr: "package lock dot jay-son") has not changed since last Thursday. [PAUSE 0.8s] It does not know that eleven of your twelve Docker (pr: "dock-er") layers are byte-for-byte identical to the last commit. [PAUSE 0.8s] It starts from scratch every time — even when scratch means identical to what it did three minutes ago. [PAUSE 1.5s]

And here is the thing about that: on a typical feature branch workflow, maybe twenty percent of your pushes actually touch a dependency. [PAUSE 0.8s] The other eighty percent are paying the full install cost for no reason at all. [PAUSE 2.0s]

---

### SECTION 3 — FIX ONE: CACHE BY LOCKFILE (2:00–5:00)

Fix one is the GitHub Actions (pr: "git-hub ack-shuns") cache, keyed to your lockfile (pr: "lock file"). [PAUSE 0.8s]

Here is the YAML (pr: "yam-ul") most teams start with:

[PAUSE 1.2s]

```yaml
- uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ github.sha }}
```

[PAUSE 1.0s]

The cache key is tied to the commit SHA (pr: "shah"). [PAUSE 0.8s] That means every commit — even a one-line comment change — busts the cache. [PAUSE 0.8s] You are downloading the same two hundred and forty packages from the npm (pr: "N-P-M") registry, on every push, regardless of whether anything changed. [PAUSE 1.5s]

Here is the fix. [PAUSE 0.5s] Four lines, already in your workflow file:

[PAUSE 1.2s]

```yaml
- uses: actions/cache@v3
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

[PAUSE 1.0s]

The key is now the hash of your package-lock.json (pr: "package lock dot jay-son"). [PAUSE 0.8s] If that file has not changed — and in eighty percent of pushes, it has not — you get a full cache hit. [PAUSE 0.8s] npm (pr: "N-P-M") install drops from two minutes seventeen to about four seconds. [PAUSE 1.5s]

The restore-keys (pr: "restore keys") line is the fallback. [PAUSE 0.8s] If your lockfile (pr: "lock file") did change, you still restore the closest previous cache and install only the delta — not every package from scratch. [PAUSE 1.5s]

On the timeline: fix one alone brings the pipeline from eight forty-two to six twenty-five on any push that does not touch a dependency. [PAUSE 0.8s] That is eighty percent of your pushes running close to two minutes faster. [PAUSE 2.0s]

---

### SECTION 4 — FIX TWO: DOCKERFILE LAYER ORDER (5:00–8:00)

Fix two is Dockerfile (pr: "dock-er file") layer ordering. [PAUSE 0.8s] This is where the Docker (pr: "dock-er") build time drops by about seventy percent. [PAUSE 1.5s]

Here is the Dockerfile (pr: "dock-er file") most people write first:

[PAUSE 1.2s]

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
```

[PAUSE 1.0s]

Docker (pr: "dock-er") builds in layers. [PAUSE 0.8s] Every COPY (pr: "copy") and RUN is a layer. [PAUSE 0.8s] When any file in the layer changes, Docker (pr: "dock-er") invalidates that layer and every layer below it. [PAUSE 1.0s]

That COPY (pr: "copy") dot dot line copies your entire project directory. [PAUSE 0.8s] A one-line change to a source file — one character — touches that layer. [PAUSE 0.8s] Which invalidates the npm (pr: "N-P-M") install layer below it. [PAUSE 0.8s] Which rebuilds all twelve layers from scratch. [PAUSE 1.5s]

The fix is to copy only what npm (pr: "N-P-M") needs first, install dependencies, then copy your source code:

[PAUSE 1.2s]

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
```

[PAUSE 1.0s]

Now when you change a source file, Docker (pr: "dock-er") replays from that second COPY (pr: "copy") — it skips the npm (pr: "N-P-M") install layer entirely because nothing above it changed. [PAUSE 1.5s]

The build log goes from every step rebuilding, to this:

[PAUSE 1.0s]

Step four of seven: RUN npm install — [PAUSE 0.5s] CACHED. [PAUSE 0.5s] Zero point zero seconds. [PAUSE 1.5s]

On the timeline: five minutes nine in Docker (pr: "dock-er") build becomes one minute twenty. [PAUSE 0.8s] Combined with fix one, you are now at two minutes fifty-five, for eighty percent of pushes. [PAUSE 2.0s]

---

### SECTION 5 — FIX THREE: BUILD ONCE (8:00–10:30)

Fix three is build once, use everywhere. [PAUSE 0.8s]

Most multi-job pipelines have a hidden tax. [PAUSE 0.8s] The test job triggers a docker build. [PAUSE 0.8s] The deploy job triggers its own docker build. [PAUSE 0.8s] That is the same five minutes paid twice — or three times, if you have a separate lint job doing the same thing. [PAUSE 1.5s]

Here is the fix: add a build job that builds and pushes the image once. [PAUSE 0.8s] Test and deploy pull that same image tag — they do not rebuild:

[PAUSE 1.2s]

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v5
        with:
          tags: ghcr.io/your-org/your-app:${{ github.sha }}
          push: true

  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: docker pull ghcr.io/your-org/your-app:${{ github.sha }}
      - run: docker run ... npm test

  deploy:
    needs: [build, test]
    runs-on: ubuntu-latest
    steps:
      - run: docker pull ghcr.io/your-org/your-app:${{ github.sha }}
      - run: docker run ... deploy
```

[PAUSE 1.0s]

Build once. [PAUSE 0.5s] Pull twice. [PAUSE 0.8s] Test and deploy run on exactly the same artifact. [PAUSE 0.8s] And you get a consistency guarantee for free — the image that passes your tests is the image that gets deployed. [PAUSE 1.5s]

On the wall-clock: two jobs that each took over five minutes now each take twelve seconds to pull the already-built image. [PAUSE 0.8s] The full pipeline — build, test, deploy in sequence — lands at one minute twelve. [PAUSE 2.0s]

---

### MID-VIDEO CTA SLOT (10:30–10:45)

[CTA INSERT — 15s — reusable drop-in clip: like/subscribe + lead magnet mention]

> "If this is useful — there is a one-page checklist for every fix in this video linked in the description. Takes two minutes to check against your own pipeline."

---

### SECTION 6 — GOING DEEPER (10:45–12:15)

Three quick additions that compound on these three fixes. [PAUSE 1.0s]

First: BuildKit (pr: "build-kit"). [PAUSE 0.8s] Docker (pr: "dock-er") BuildKit (pr: "build-kit") is on by default since Docker (pr: "dock-er") 23, and it gives you parallel layer builds. [PAUSE 0.8s] If your Dockerfile (pr: "dock-er file") has independent build stages — a separate assets stage and a server stage — they run concurrently. [PAUSE 0.8s] If you are on an older version, DOCKER_BUILDKIT equals one in your environment enables it today. [PAUSE 1.5s]

Second: multi-stage builds. [PAUSE 0.8s] Your build stage does not need to ship with your source code, your devDependencies (pr: "dev deh-pen-den-seez"), or your compiler. [PAUSE 0.8s] A two-stage Dockerfile (pr: "dock-er file") that builds in one stage and copies only the output to a lean runtime image can cut your final image from eight hundred megabytes to sixty. [PAUSE 0.8s] Smaller image: faster push to the registry, faster pull in CI, and a smaller attack surface in production. [PAUSE 1.5s]

Third: how to find your own bottleneck. [PAUSE 0.8s] In GitHub Actions (pr: "git-hub ack-shuns"), click into any run, expand the job, and look at the step durations. [PAUSE 0.8s] Sort by slowest. [PAUSE 0.8s] The longest step is your fix-one target. [PAUSE 0.8s] Apply the fix, run again, and repeat the process. [PAUSE 0.8s] You are looking for the step where the duration drops by ninety percent on the second run — that is the cache working. [PAUSE 2.0s]

---

### SECTION 7 — RECAP (12:15–13:00)

Before this: eight minutes, forty-two seconds. [PAUSE 0.5s] Every push. [PAUSE 0.5s] Every developer on the team. [PAUSE 1.5s]

Three changes: [PAUSE 0.8s]

Fix one — cache by lockfile (pr: "lock file"), not by commit. [PAUSE 0.8s]
Fix two — order your Dockerfile (pr: "dock-er file") stable to volatile. [PAUSE 0.8s]
Fix three — build your artifact once and pull it downstream. [PAUSE 1.5s]

After: one minute, twelve seconds. [PAUSE 0.8s] Same pipeline. [PAUSE 0.5s] Same tests. [PAUSE 0.5s] Same team. [PAUSE 0.8s] Seven times faster, with nothing new to maintain. [PAUSE 1.5s]

If your build is over ten minutes, the same three fixes apply — the savings scale with the problem. [PAUSE 0.8s] If you are already under two minutes, look at test parallelism next — different bottleneck, different playbook. [PAUSE 2.0s]

---

### LEAD MAGNET SLOT (13:00–13:15)

[LEAD MAGNET INSERT — 15s — reusable drop-in clip: checklist CTA]

> "The CI cache checklist is in the description — one page, three fixes, a column for your before and after numbers."

---

### [OUTRO INSERT — reusable bookend asset]

---

## END OF SCRIPT

**Word count:** ~1,720 words  
**Estimated runtime at Charon TTS pace (~130 wpm):** 13.2 minutes (including pauses)  
**CTA slots:** 2 — mid-video at 10:30, lead magnet at 13:00  
**Pause markup:** present throughout — TTS must render these as real silence, not strip them
