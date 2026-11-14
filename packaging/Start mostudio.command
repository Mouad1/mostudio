#!/bin/bash
# Double-click to start mostudio. Keep this window open while you work.
here="$(cd "$(dirname "$0")" && pwd)"
xattr -dr com.apple.quarantine "$here" 2>/dev/null || true
export PATH="$here/runtime/node/bin:$here/runtime/bin:$PATH"
export FFMPEG="$here/runtime/bin/ffmpeg" FFPROBE="$here/runtime/bin/ffprobe" MOSTUDIO_PACKAGED=1
clear
echo "Starting mostudio…"
exec "$here/runtime/node/bin/node" --disable-warning=ExperimentalWarning "$here/app/cli/bin/mostudio.ts" ui --open
