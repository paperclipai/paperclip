# Video Temporal QA

Use for assembled YouTube cuts before closeout.

## Timeline budget first

Compute usable unique-footage seconds before assembly. Count each source asset once after trims. If
unique footage is shorter than the VO or final duration, the plan must name fill techniques:
generate/source more clips, speed-ramp holds, stills with Ken Burns, or section cards. Naive looping
is forbidden.

## Cut-map is mandatory

A final cut is not closeable without `assets/final/cut-map/cut-map.json`. Generate it from the final
render with scene detection, map every segment back to a source asset by frame hash, and attach it
beside the MP4.

## Pass rules

- No source clip is used more than twice.
- No adjacent segments use the same source.
- Repeated use of the same source is separated by at least 90 seconds.
- No span longer than 20 seconds lacks a detected visual change.
- Black and frozen spans are zero.

If the cut-map fails, fix the timeline and rerun export plus QA. When the TSBC-1586 vision judge is
validated, run it after the cut-map as the second mandatory temporal-QA gate.
