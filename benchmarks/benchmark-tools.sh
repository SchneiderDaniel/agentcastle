#!/bin/bash
# Benchmark: measure token consumption of pi agent under 4 tool configs
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_DIR="$PROJECT_DIR/.pi"
SESSIONS_DIR="$PI_DIR/sessions"
RESULTS_DIR="$SCRIPT_DIR/benchmark-results"
RUNS=${RUNS:-2}  # default 2 for quick test, override with RUNS=5

TASK="Audit test coverage of chart/figure generation methods in flask_planhead/app/services/. Steps:
1. Find all service files with generate_*_figure() methods
2. Check each for corresponding test coverage in flask_planhead/tests/
3. Report coverage gaps and recommend which test files need extension"

CONFIGS=(
  "1-no-tools|--no-tools --no-extensions"
  "2-builtin-mapper|--no-extensions -e $PROJECT_DIR/.pi/extensions/ranked-map.ts"
  "3-builtin-mapper-structural|--no-extensions -e $PROJECT_DIR/.pi/extensions/ranked-map.ts -e $PROJECT_DIR/.pi/extensions/structural-analyzer.ts"
  "4-builtin-mapper-structural-rg|--no-extensions -e $PROJECT_DIR/.pi/extensions/ranked-map.ts -e $PROJECT_DIR/.pi/extensions/structural-analyzer.ts -e $PROJECT_DIR/.pi/extensions/ripgrep-search/index.ts"
)

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$RESULTS_DIR"
rm -f "$RESULTS_DIR/results.csv"
echo "config,run,tokens_in,tokens_out,tokens_total,cost,duration_ms" > "$RESULTS_DIR/results.csv"

echo -e "${BLUE}=== Pi Agent Tool Benchmark ===${NC}"
echo "Task: audit figure generation test coverage in flask_planhead"
echo "Configs: ${#CONFIGS[@]}, Runs per config: $RUNS"
echo ""

for config_entry in "${CONFIGS[@]}"; do
  IFS='|' read -r name args <<< "$config_entry"
  echo -e "${GREEN}--- Config: $name ---${NC}"

  for run in $(seq 1 $RUNS); do
    echo -n "  Run $run... "

    # Timestamp before run — used to identify session file
    run_ts=$(date -u +%Y-%m-%dT%H-%M-%S)

    start_ms=$(date +%s%N)

    # Run pi non-interactively
    output=$(cd "$PROJECT_DIR" && pi --print --thinking off $args "$TASK" 2>&1; exit 0)

    end_ms=$(date +%s%N)
    duration_ms=$(( (end_ms - start_ms) / 1000000 ))

    # Save response text (sanitize config name for filename)
    safe_name=$(echo "$name" | sed 's/[^a-zA-Z0-9_-]/_/g')
    echo "$output" > "$RESULTS_DIR/${safe_name}_run${run}_output.txt"

    # Find session file created around this run (newest file that starts with run_ts prefix)
    session_file=""
    shopt -s nullglob
    for sf in "$SESSIONS_DIR"/"$run_ts"*.jsonl; do
      session_file="$sf"
      break
    done
    # Fallback: use most recent session file by mtime
    if [[ -z "$session_file" ]]; then
      session_file=$(find "$SESSIONS_DIR" -name '*.jsonl' -not -name 'latest.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | awk '{print $2}')
    fi

    # Extract token totals from session JSONL
    tokens_in=0; tokens_out=0; tokens_total=0; cost=0
    if [[ -n "$session_file" && -f "$session_file" ]]; then
      read -r tokens_in tokens_out tokens_total cost <<< "$(
        python3 -c "
import json, sys
tin=0; tout=0; ttotal=0; cost=0
with open('$session_file') as f:
    for line in f:
        d = json.loads(line)
        if d.get('type') == 'message':
            msg = d.get('message', {})
            usage = msg.get('usage', {})
            if usage:
                tin += usage.get('input', 0)
                tout += usage.get('output', 0)
                ttotal += usage.get('totalTokens', 0)
                c = usage.get('cost', {})
                if isinstance(c, dict):
                    cost += c.get('total', 0)
                elif isinstance(c, (int, float)):
                    cost += c
print(f'{tin} {tout} {ttotal} {cost}')
" 2>/dev/null || echo "0 0 0 0"
      )"
    fi

    echo "$name,$run,$tokens_in,$tokens_out,$tokens_total,$cost,$duration_ms" >> "$RESULTS_DIR/results.csv"
    echo "in=$tokens_in out=$tokens_out total=$tokens_total cost=$cost ${duration_ms}ms"
  done
done

# Summary table
echo ""
echo -e "${BLUE}=== Results Summary ===${NC}"
printf "%-30s %-5s %-10s %-10s %-12s %-10s\n" "Config" "Run" "Input" "Output" "Total" "Duration"
printf "%-30s %-5s %-10s %-10s %-12s %-10s\n" "------" "---" "-----" "------" "-----" "--------"
while IFS=',' read -r cfg run tin tout total cost dur; do
  [[ "$cfg" == "config" ]] && continue
  printf "%-30s %-5s %-10s %-10s %-12s %-10s\n" "$cfg" "$run" "$tin" "$tout" "$total" "${dur}ms"
done < "$RESULTS_DIR/results.csv"

# Averages per config
echo ""
echo -e "${BLUE}=== Averages per Config ===${NC}"
printf "%-30s %-12s %-12s %-12s %-12s\n" "Config" "Avg Input" "Avg Output" "Avg Total" "Avg Duration"
printf "%-30s %-12s %-12s %-12s %-12s\n" "-----" "--------" "---------" "---------" "----------"
for cfg_name in "1-no-tools" "2-builtin-mapper" "3-builtin-mapper-structural" "4-builtin-mapper-structural-rg"; do
  awk -F',' -v cfg="$cfg_name" '
    $1 == cfg { tin+=$3; tout+=$4; ttotal+=$5; dur+=$7; n++ }
    END {
      if (n>0) {
        printf "%-30s %-12.0f %-12.0f %-12.0f %-12dms\n", cfg, tin/n, tout/n, ttotal/n, dur/n
      }
    }
  ' "$RESULTS_DIR/results.csv"
done

echo ""
echo "Full outputs saved to: $RESULTS_DIR/"
echo "Done."
