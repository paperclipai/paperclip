# Media File Engine Specification

## Purpose

Create the engine that turns SINK DINK content plans into final upload-ready files.

The user should receive final files and manually upload them.

## Required final output

```
final_upload_pack/
├── reels/
│   ├── reel_01.mp4
│   ├── reel_02.mp4
│   ├── reel_03.mp4
│   ├── subtitles_01.srt
│   └── reel_scripts.md
├── carousels/
│   ├── carousel_01_slide_01.png
│   ├── carousel_01_slide_02.png
│   ├── carousel_01_slide_03.png
│   └── carousel_text.md
├── captions/
│   ├── instagram_captions.md
│   ├── youtube_shorts_captions.md
│   └── hashtags.md
├── preview/
│   └── platform_preview.html
├── qa/
│   └── qa_report.md
└── upload_checklist.md
```

## Engine layers

### Layer 1: Content pack

Creates:

- topics
- hooks
- scripts
- carousel text
- captions
- hashtags
- design brief

### Layer 2: Visual pack

Creates:

- slide layouts
- background rules
- text placement
- export-ready carousel images

### Layer 3: Audio pack

Creates:

- voiceover text
- voice style plan
- subtitle text
- timing rules

### Layer 4: Video pack

Creates:

- reel visual sequence
- subtitle overlay plan
- MP4 render

### Layer 5: Final pack

Creates:

- final folder
- preview
- QA report
- upload checklist

## MVP file generation approach

First build a simple renderer:

1. HTML template for carousel slides
2. Export HTML to image
3. Script plus subtitle file for reels
4. Simple MP4 render using a video renderer package
5. Zip final output pack

## Quality rules

- Each reel should have one strong hook.
- Each carousel should have a clear first slide.
- Text must be readable on mobile.
- Captions should include a CTA.
- Every file name must be predictable.
- Every final output must have a QA report.

## Manual upload boundary

The system prepares files only. The user performs manual upload.
