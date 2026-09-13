#!/usr/bin/env bash
# Round-trip the bridge's own speech providers: say a known sentence with the
# configured speech-out engine, hear it back through the configured speech-in
# engine, and see whether the words survived.
#
#   digital  — synth → PCM → /transcribe. Tests the two providers.
#   acoustic — synth → speakers → record the monitor → /transcribe. Tests the
#              providers *and* the machine's audio path, which is the half a
#              unit test can never reach.
set -uo pipefail

BRIDGE="${BRIDGE:-http://127.0.0.1:8787}"
TOKEN="${APP_TOKEN:?set APP_TOKEN}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SINK="$(pactl get-default-sink 2>/dev/null)"
MONITOR="${SINK}.monitor"

PHRASES=(
  "The quick brown fox jumps over the lazy dog."
  "Open the config tab and restart the bridge."
  "I finished the refactor and all the tests are passing."
)

norm() {
  tr '[:upper:]' '[:lower:]' \
  | sed -E 's/([0-9])\.([0-9])/\1 \2/g' \
  | tr -cd '[:alnum:] ' | tr -s ' ' | sed 's/^ //;s/ $//'
}

# Word error rate, rounded to a percentage.
wer() {
  python3 - "$1" "$2" <<'PY'
import sys
ref, hyp = sys.argv[1].split(), sys.argv[2].split()
d = [[0]*(len(hyp)+1) for _ in range(len(ref)+1)]
for i in range(len(ref)+1): d[i][0] = i
for j in range(len(hyp)+1): d[0][j] = j
for i in range(1, len(ref)+1):
    for j in range(1, len(hyp)+1):
        d[i][j] = min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(ref[i-1] != hyp[j-1]))
print(round(100 * d[len(ref)][len(hyp)] / max(1, len(ref))))
PY
}

synth() { # phrase -> mp3 path
  curl -s -D "$WORK/h.txt" -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$1")" \
    "$BRIDGE/api/intelligence/tts" -o "$WORK/say.mp3"
  grep -i '^x-speech-provider' "$WORK/h.txt" | tr -d '\r' | awk '{print $2}'
}

stt() { # pcm path -> transcript
  curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/octet-stream' \
    --data-binary "@$1" "$BRIDGE/api/intelligence/transcribe" \
  | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); print(d.get("text") or "[empty] "+str(d.get("error","")))
except Exception as e: print("[bad response]")'
}

fails=0
printf '%-9s %-6s %-4s  %s\n' MODE PROV WER TRANSCRIPT
printf '%s\n' "---------------------------------------------------------------"

for phrase in "${PHRASES[@]}"; do
  echo
  echo "ref: $phrase"

  provider="$(synth "$phrase")"
  [[ -s "$WORK/say.mp3" ]] || { echo "  synth FAILED"; fails=$((fails+1)); continue; }

  # ── digital ──
  ffmpeg -y -loglevel error -i "$WORK/say.mp3" -ar 16000 -ac 1 -f s16le "$WORK/d.pcm"
  got="$(stt "$WORK/d.pcm")"
  w="$(wer "$(printf '%s' "$phrase" | norm)" "$(printf '%s' "$got" | norm)")"
  printf '%-9s %-6s %-4s  %s\n' digital "${provider:-?}" "${w}%" "$got"
  [[ "$w" -gt 25 ]] && fails=$((fails+1))

  # ── acoustic ──
  if [[ -n "$SINK" ]]; then
    parecord --device="$MONITOR" --file-format=wav --rate=16000 --channels=1 "$WORK/a.wav" &
    rec=$!
    sleep 0.8
    paplay "$WORK/say.mp3" 2>/dev/null
    # paplay returns when the buffer is handed over, not when the speaker is
    # done with it. Stopping here clips the tail off every phrase.
    sleep 2.5
    kill -INT "$rec" 2>/dev/null; wait "$rec" 2>/dev/null
    ffmpeg -y -loglevel error -i "$WORK/a.wav" -ar 16000 -ac 1 -f s16le "$WORK/a.pcm"
    got="$(stt "$WORK/a.pcm")"
    w="$(wer "$(printf '%s' "$phrase" | norm)" "$(printf '%s' "$got" | norm)")"
    printf '%-9s %-6s %-4s  %s\n' acoustic "${provider:-?}" "${w}%" "$got"
    [[ "$w" -gt 40 ]] && fails=$((fails+1))
  fi
done

echo
if [[ "$fails" -eq 0 ]]; then echo "PASS — every phrase survived the round trip"; else echo "FAIL — $fails leg(s) over threshold"; fi
exit $(( fails > 0 ? 1 : 0 ))
