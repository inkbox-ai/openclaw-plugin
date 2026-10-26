#!/usr/bin/env bash
# Source before dependency installation. The ordinary manifest remains semver-based.
set -euo pipefail
candidate_revision=52455f5d0f11acd2e3a0e4a9eeb8d5585485bec5
candidate_directory="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/inkbox-sdk-candidate.XXXXXX")"
git clone --quiet --filter=blob:none --no-checkout https://github.com/inkbox-ai/inkbox.git "$candidate_directory/source"
git -C "$candidate_directory/source" fetch --quiet --depth=1 origin "$candidate_revision"
git -C "$candidate_directory/source" checkout --quiet --detach "$candidate_revision"
(
  cd "$candidate_directory/source/sdk/typescript"
  npm ci --no-audit --no-fund
  npm run build
  npm pack --pack-destination "$candidate_directory" --silent
)
export INKBOX_SDK_CANDIDATE_TGZ="$candidate_directory/inkbox-sdk-0.7.21.tgz"
cp package.json "$candidate_directory/plugin-package.json"
npm install --package-lock-only --ignore-scripts --no-audit --no-fund "$INKBOX_SDK_CANDIDATE_TGZ"
cp "$candidate_directory/plugin-package.json" package.json
node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync('package.json','utf8'));
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
lock.packages[''].dependencies['@inkbox/sdk']=manifest.dependencies['@inkbox/sdk'];
writeFileSync('package-lock.json',JSON.stringify(lock,null,2)+'\n');
JS
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'INKBOX_SDK_CANDIDATE_TGZ=%s\n' "$INKBOX_SDK_CANDIDATE_TGZ" >> "$GITHUB_ENV"
fi
