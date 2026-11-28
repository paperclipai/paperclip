---
name: bb-video
description: >
  Use for producing promo/explainer videos: turning an approved script into a
  narrated, captioned 16:9 MP4 via the bb-video pipeline (TTS with word-level
  timeline, cue-scripted scenes, headless render). Covers project setup,
  rendering, revision loops, and archiving with desensitization discipline.
---

# bb-video 视频制作技能

把定稿剧本渲染成带配音、字幕、图表动画的成片。产线四步：**剧本 → 配音 → cue 场景 → 渲染归档**。

## 工具链位置

所有脚本在宿主技能目录（不在本 skill 内复制，避免双份维护）：

- `~/.claude/skills/bb-video/promo/scripts/new.mjs` — 新建工程
- `~/.claude/skills/bb-video/promo/scripts/render.mjs <工程> [--force]` — 渲染成片 + srt 字幕
- `~/.claude/skills/bb-video/explainer/scripts/tts.py` — 重新生成配音与词级时间轴
- 制片规范：`~/.claude/skills/bb-video/promo/GUIDE.md`

## 产线流程

1. **建工程**：`node ~/.claude/skills/bb-video/promo/scripts/new.mjs <name>`。工程含 `index.html`（cue 场景脚本）、`script.json`（逐句旁白文本）、`lib/`、`audio/`。
2. **写剧本**：`script.json` 每句一个 id（p1, p2…），文案定稿后再配音，改一句重跑一次 TTS。
3. **配音**：TTS 必须用 `/Users/yueming/miniforge3/bin/python3`（edge-tts 只装在这支 python）。重生成 `audio/lines/*.mp3` + `timeline.js`（词级时间点，cue 锚定靠它）。
4. **写 cue**：`index.html` 里逐场动画，cue 用 `at: ['p8', '从']` 锚定到旁白具体字词。改 cue 不需要重跑 TTS。
5. **渲染**：`node ~/.claude/skills/bb-video/promo/scripts/render.mjs <工程> --force`，产出 `out/video-16x9.mp4` + `captions-16x9.srt`。
6. **归档**：`ffmpeg -y -i out/video-16x9.mp4 -c copy -movflags +faststart <归档名>.mp4`（faststart 必做，否则流媒体播放卡）。

## 硬性纪律

- **工程与素材不允许只存 /tmp**：每个里程碑后把工程目录同步到 `~/Movies/<客户或项目>/工程文件/`，成片归档同目录。/tmp 重启即失。
- **脱敏先于渲染**：真实公司名、人名、邮箱、手机号不得进入剧本、cue 文案、画面素材。渲前用 grep 扫 script.json 与字幕输出确认。真实案例用"某行业集团"式占位并标注"信息已脱敏"。
- **验收靠帧**：文字重叠、遮挡类问题用 ffmpeg 抽帧（`ffmpeg -ss <t> -i out/video-16x9.mp4 -frames:v 1 check.png`）+ 图像分析确认，不要只看 DOM。

## 常见坑

- cue 锚点太晚会被场景 coverT 截断（步骤播不完）——锚到更早的字词。
- 图表数字尺寸要按实际渲染宽度封顶，estUnits 估宽需 ×1.18 安全系数（粗体数字更宽）。
- 改了 script.json 必须重跑 TTS，否则 timeline.js 与音频错位。

## 进度汇报（看板）

每个里程碑（剧本定稿/配音完成/分场制作/渲染完成/审片通过/归档）在任务评论更新状态，并附成片/帧的下载链接。里程碑结构见 [references/pipeline.md](references/pipeline.md)。

## 范例工程

完整的 12 拍宣讲片工程（含漏斗图表、数字卡、脱敏案例卡）：`~/Movies/Dataflare/工程文件/宣讲会成片工程/`。剧本与 cue 写法以它为准。
