#!/usr/bin/env bash
# S1 spike: transcribe each clip in media/ with 3 engines, then score WER against <clip>.ref.txt.
#   moos secrets run hermes -- spikes/s1-stt/run.sh darija-01 darija-02 darija-03
# Outputs: media/out/<clip>.<engine>.txt (+ .json). Engines: groq-large-v3, wcpp-large-v3, wcpp-turbo.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
media="$here/media"; out="$media/out"; models="${WHISPER_MODELS:-/Volumes/1TBT705CRUCIAL/ai-cache/whisper}"
mkdir -p "$out"
for clip in "$@"; do
  src="$(ls "$media/$clip".* | grep -v -E '\.(txt|wav)$' | head -1)"
  wav="$out/$clip.wav"
  ffmpeg -nostdin -loglevel error -y -i "$src" -ac 1 -ar 16000 -c:a pcm_s16le "$wav"
  for m in large-v3 large-v3-turbo; do
    tag="wcpp-${m/large-v3-turbo/turbo}"
    s=$(date +%s)
    whisper-cli -m "$models/ggml-$m.bin" -l auto -f "$wav" -oj -of "$out/$clip.$tag" -np >/dev/null 2>&1
    node -e 'const j=require(process.argv[1]);process.stdout.write(j.transcription.map(s=>s.text.trim()).join("\n")+"\n")' "$out/$clip.$tag.json" > "$out/$clip.$tag.txt"
    echo "$clip $tag $(( $(date +%s) - s ))s"
  done
  s=$(date +%s)
  curl -sS --fail-with-body https://api.groq.com/openai/v1/audio/transcriptions \
    -H "Authorization: Bearer $GROQ_API_KEY" -F model=whisper-large-v3 -F response_format=verbose_json \
    -F timestamp_granularities[]=word -F file=@"$wav" > "$out/$clip.groq-large-v3.json"
  node -e 'const j=require(process.argv[1]);process.stdout.write(j.text.trim()+"\n")' "$out/$clip.groq-large-v3.json" > "$out/$clip.groq-large-v3.txt"
  echo "$clip groq-large-v3 $(( $(date +%s) - s ))s"
done
node "$here/wer.mjs" "$media" "$@"
