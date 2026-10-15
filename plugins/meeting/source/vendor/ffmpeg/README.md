# FFmpeg Vendor Runtime

The meeting plugin can bundle a Windows x64 LGPL-only shared FFmpeg runtime for
large file uploads. The binary payload is intentionally not committed to git.

Install locally:

```sh
bun run install:ffmpeg:win64
bun run build
```

The installer uses BtbN's `win64-lgpl-shared` FFmpeg build by default. Keep the
artifact LGPL-only: do not use `gpl`, `gpl-shared`, or `nonfree` variants unless
the distribution model has had a separate legal review.

At runtime the plugin resolves executables in this order:

1. `AVE_MEETING_FFMPEG_PATH` / `AVE_MEETING_FFPROBE_PATH`
2. `AVE_MEETING_FFMPEG_DIR`
3. `dist/vendor/ffmpeg/<platform-arch>/bin`
4. system `PATH`
