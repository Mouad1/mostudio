#!/usr/bin/env bash
# S1 round 2: force language=ar and give a Darija code-switching prompt. Needs run.sh first (reuses out/<clip>.wav).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; out="$here/media/out"; models="${WHISPER_MODELS:-/Volumes/1TBT705CRUCIAL/ai-cache/whisper}"
prompt="واش نتا مزيان؟ دابا غادي نشرح ليكم كيفاش كنخدم ب workflow، outil، montage، mostudio، Groq، Gemini، Whisper، ffmpeg، HyperFrames."
for clip in "$@"; do
  wav="$out/$clip.wav"
  curl -sS --fail-with-body https://api.groq.com/openai/v1/audio/transcriptions -H "Authorization: Bearer $GROQ_API_KEY" \
    -F model=whisper-large-v3 -F language=ar -F "prompt=$prompt" -F response_format=json -F file=@"$wav" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).text.trim()+"\n"))' > "$out/$clip.groq-ar-prompt.txt"
  whisper-cli -m "$models/ggml-large-v3.bin" -l ar --prompt "$prompt" -f "$wav" -oj -of "$out/$clip.wcpp-large-v3-ar-prompt" -np >/dev/null 2>&1
  node -e 'const j=require(process.argv[1]);process.stdout.write(j.transcription.map(s=>s.text.trim()).join("\n")+"\n")' "$out/$clip.wcpp-large-v3-ar-prompt.json" > "$out/$clip.wcpp-large-v3-ar-prompt.txt"
  echo "$clip done"
done
node "$here/wer.mjs" "$here/media" "$@"
