#!/usr/bin/env bash
set -euo pipefail

# Interactive release flow for apple-fm. Adapted from the kerf release script
# (same family).
#
# Usage:
#   bash scripts/release.sh           — full stable release (bumps version,
#                                       updates CHANGELOG, commits, tags
#                                       v{ver}, pushes; CI publishes to npm and
#                                       attaches the signed + notarized helper).
#   bash scripts/release.sh --beta    — beta tag-only flow (does NOT bump
#                                       version files, does NOT update the
#                                       changelog, does NOT commit; just tags
#                                       v{ver}-beta.{N} off HEAD; CI publishes
#                                       with --tag beta).
#
# The actual signing / notarization / npm publish happens in CI
# (.github/workflows/release.yml) — this script only prepares the tag. See
# docs/5-releasing.md for the one-time secrets setup CI needs.

# --- Config ---
STATE_FILE=".release-state.json"
PACKAGE_JSON="package.json"

# --- Colors ---
BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

# --- Helpers ---
info()    { echo -e "${CYAN}${BOLD}>>>${RESET} $1"; }
success() { echo -e "${GREEN}${BOLD}>>>${RESET} $1"; }
warn()    { echo -e "${YELLOW}${BOLD}>>>${RESET} $1"; }
error()   { echo -e "${RED}${BOLD}>>>${RESET} $1"; }

confirm() {
  local prompt="$1"
  local response
  echo -en "${CYAN}${BOLD}>>>${RESET} ${prompt} ${DIM}[y/N]${RESET} "
  read -r response
  [[ "$response" =~ ^[Yy]$ ]]
}

resolve_editor() {
  if [[ -n "${EDITOR:-}" ]]; then echo "$EDITOR"; return; fi
  if [[ -n "${VISUAL:-}" ]]; then echo "$VISUAL"; return; fi
  for cmd in nano vim vi; do
    if command -v "$cmd" &>/dev/null; then echo "$cmd"; return; fi
  done
  echo ""
}

ask_multiline() {
  local key="$1"
  local prompt="$2"
  local initial="${3:-}"
  local prev
  prev=$(get_state "$key")

  if [[ -n "$prev" ]]; then
    initial="$prev"
  fi

  local editor
  editor=$(resolve_editor)
  if [[ -z "$editor" ]]; then
    error "No editor found. Set \$EDITOR and try again."
    exit 1
  fi

  local tmpfile
  tmpfile=$(mktemp "${TMPDIR:-/tmp}/apple-fm-release-notes.XXXXXX")
  trap "rm -f '$tmpfile'" RETURN

  if [[ -n "$initial" ]]; then
    echo -e "$initial" > "$tmpfile"
  fi

  while true; do
    info "${prompt} ${DIM}(opening ${editor##*/})${RESET}"
    $editor "$tmpfile"

    # Strip guidance comments — lines that are a lone '#' or start with '# '
    # (hash + space) — then trailing blanks. Preserves Markdown headings
    # ('## Features', '### Bug Fixes').
    REPLY=$(grep -vE '^#( |$)' "$tmpfile" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')

    if [[ -z "$REPLY" ]]; then
      warn "Release notes are empty."
      if ! confirm "Open editor again?"; then
        error "Aborted — release notes are required."
        exit 1
      fi
      continue
    fi

    echo ""
    echo -e "    ${DIM}Release notes:${RESET}"
    echo "$REPLY" | sed 's/^/    /'
    echo ""

    if confirm "Use this text?"; then
      break
    fi
    echo "$REPLY" > "$tmpfile"
  done

  set_state "$key" "$REPLY"
}

# --- State management ---
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo '{}' > "$STATE_FILE"
  fi
}

get_state() {
  node -e "
    const s = JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8'));
    process.stdout.write(s[process.argv[1]] || '');
  " "$1" 2>/dev/null || echo ""
}

set_state() {
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$STATE_FILE','utf8'));
    s[process.argv[1]] = process.argv[2];
    fs.writeFileSync('$STATE_FILE', JSON.stringify(s, null, 2));
  " "$1" "$2"
}

get_step() { get_state "_step"; }
set_step() { set_state "_step" "$1"; }
past_step() {
  local current
  current=$(get_step)
  [[ -n "$current" ]] && [[ "$current" -gt "$1" ]]
}
cleanup_state() { rm -f "$STATE_FILE"; }

# --- Pre-flight ---
preflight() {
  info "Running pre-flight checks..."

  if [[ ! -f "$PACKAGE_JSON" ]]; then
    error "No package.json found. Run from the project root."
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    warn "Working directory is not clean:"
    git status --short
    echo ""
    if ! confirm "Continue anyway?"; then exit 1; fi
  fi

  if ! npm whoami &>/dev/null; then
    warn "Not logged in to npm locally — that's OK if you rely on CI's OIDC publish."
  else
    local npm_user
    npm_user=$(npm whoami)
    success "Logged in to npm as ${BOLD}${npm_user}${RESET}"
  fi

  local branch
  branch=$(git branch --show-current)
  if [[ "$branch" != "main" && "$branch" != "master" ]]; then
    warn "On branch '${branch}', not main/master."
    if ! confirm "Continue anyway?"; then exit 1; fi
  fi
}

# --- Steps ---
step_release_notes() {
  echo ""

  local prev
  prev=$(get_state "release_notes")
  if [[ -n "$prev" ]]; then
    ask_multiline "release_notes" "Release notes" ""
    return
  fi

  local last_tag
  last_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  local log_range="${last_tag:+${last_tag}..HEAD}"

  local commit_log
  commit_log=$(git log ${log_range:-"-30"} --format="%s" --no-decorate)

  # Draft release notes with the signed-in `claude` CLI directly (`claude -p`).
  # We deliberately do NOT use gitgist here: gitgist will soon depend on apple-fm,
  # so apple-fm must not depend on gitgist (that would be a dependency cycle). Gate
  # on `claude` being available and fall back to manual entry otherwise.
  local generated=""
  if command -v claude &>/dev/null; then
    info "Drafting release notes with Claude (commits since ${last_tag:-the start})..."
    local prompt
    prompt=$(cat <<EOF
Draft release notes for apple-fm, a CLI and library for Apple on-device Foundation Models (Apple Intelligence), from the commit subjects below.

Rules:
- Output ONLY markdown: group changes under Markdown section headings such as ## Features or ## Fixes, with one short user-facing bullet per change. No preamble, no closing remarks.
- INCLUDE: new features, behavior changes, bug fixes, breaking changes — anything a user upgrading would notice.
- EXCLUDE: ticket IDs (AFM-/AF- numbers), internal refactors, test-only changes, doc-only changes, build/CI tweaks, implementation rationale.
- Keep it short — a handful of bullets. Fewer is better.

Commits:
${commit_log}
EOF
)
    generated=$(claude -p "$prompt" 2>/dev/null || true)
    generated=$(echo "$generated" | sed -e '/^```/d' -e :a -e '/^[[:space:]]*$/{$d;N;ba' -e '}')
  fi

  local initial
  if [[ -n "$generated" ]]; then
    success "Claude draft ready — review and edit in the editor."
    initial="# Release notes — Claude drafted these from your own commits. Edit freely.
# Lines that are a lone '#' or start with '# ' are guidance and removed on save;
# Markdown headings ('## Features') are kept.

${generated}"
  else
    initial="# Release notes — keep them SHORT and USER-FACING.
# Group changes under '## Section' headings; skip ticket IDs, refactors, tests,
# doc-only changes, and CI/build tweaks. Lines starting with '# ' are removed.

## "
  fi

  ask_multiline "release_notes" "Release notes" "$initial"
}

step_version() {
  local current_version
  current_version=$(node -p "require('./package.json').version")
  info "Current version: ${BOLD}${current_version}${RESET}"

  local major minor patch
  IFS='.' read -r major minor patch <<< "$current_version"
  local next_patch="${major}.${minor}.$((patch + 1))"
  local next_minor="${major}.$((minor + 1)).0"
  local next_major="$((major + 1)).0.0"

  echo ""
  echo -e "    ${DIM}Enter)${RESET} keep   ${BOLD}${current_version}${RESET} ${DIM}(no change)${RESET}"
  echo -e "    ${DIM}1)${RESET}     patch  ${BOLD}${next_patch}${RESET}"
  echo -e "    ${DIM}2)${RESET}     minor  ${BOLD}${next_minor}${RESET}"
  echo -e "    ${DIM}3)${RESET}     major  ${BOLD}${next_major}${RESET}"
  echo -e "    ${DIM}4)${RESET}     custom"
  echo ""

  local prev_version
  prev_version=$(get_state "version")
  if [[ -n "$prev_version" && "$prev_version" != "$current_version" ]]; then
    echo -e "    ${DIM}Previous selection:${RESET} ${prev_version}"
    if confirm "Keep ${prev_version}?"; then
      REPLY="$prev_version"
      set_state "version" "$REPLY"
      return
    fi
  fi

  echo -en "${CYAN}${BOLD}>>>${RESET} Choose version bump ${DIM}[Enter/1/2/3/4]${RESET} "
  local choice
  read -r choice
  case "$choice" in
    "") REPLY="$current_version" ;;
    1) REPLY="$next_patch" ;;
    2) REPLY="$next_minor" ;;
    3) REPLY="$next_major" ;;
    4)
      echo -en "${CYAN}${BOLD}>>>${RESET} Enter version: "
      read -r REPLY
      ;;
    *) error "Invalid choice"; exit 1 ;;
  esac

  set_state "version" "$REPLY"
}

step_update_changelog() {
  local version notes date
  version=$(get_state "version")
  notes=$(get_state "release_notes")
  date=$(date +%Y-%m-%d)

  info "Updating CHANGELOG.md..."

  # Demote top-level note headings ('## Features') one level so they nest under
  # the changelog's '## [version]' entry.
  local body
  body=$(echo "$notes" | sed -E 's/^## /### /')

  local entry="## [${version}] - ${date}\n\n${body}"

  if [[ ! -f CHANGELOG.md ]]; then
    cat > CHANGELOG.md <<'HDR'
# Changelog

All notable changes to apple-fm are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
semantic versioning.
HDR
  fi

  # Insert the new entry above the first existing '## [' version section (or, if
  # there is an "## [Unreleased]" section, immediately after it), else append.
  node -e "
    const fs = require('fs');
    const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
    const entry = process.argv[1];
    const marker = changelog.indexOf('\n## [');
    if (marker === -1) {
      const updated = changelog.replace(/\s*\$/, '') + '\n\n' + entry + '\n';
      fs.writeFileSync('CHANGELOG.md', updated);
    } else {
      const updated = changelog.slice(0, marker) + '\n' + entry + '\n' + changelog.slice(marker);
      fs.writeFileSync('CHANGELOG.md', updated);
    }
  " "$(echo -e "$entry")"

  success "CHANGELOG.md updated"
}

step_review() {
  local version notes
  version=$(get_state "version")
  notes=$(get_state "release_notes")

  echo ""
  echo -e "${BOLD}━━━ Release Summary ━━━${RESET}"
  echo ""
  echo -e "  ${DIM}Version:${RESET}  ${BOLD}${version}${RESET}"
  echo -e "  ${DIM}Notes:${RESET}"
  echo -e "$notes" | sed 's/^/    /'
  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
}

step_local_checks() {
  info "Running local checks..."
  echo ""
  info "Type checking..."
  npm run typecheck
  echo ""
  info "Lint..."
  npm run lint
  echo ""
  info "Tests..."
  npm test
  echo ""
  info "Build..."
  npm run build
  success "All local checks passed"
}

step_update_version() {
  local version
  version=$(get_state "version")
  info "Updating version to ${BOLD}v${version}${RESET}..."
  npm version "$version" --no-git-tag-version --allow-same-version
  success "package.json updated"
}

step_git_commit() {
  local version
  version=$(get_state "version")
  info "Creating git commit..."
  git add package.json package-lock.json CHANGELOG.md
  # Idempotent: if a previous run already absorbed these files into a commit
  # (e.g. recovery after a failed run), there's nothing left to stage. Skip
  # rather than fail under `set -e` so the tag-and-push step still runs.
  if git diff --cached --quiet; then
    info "No staged changes — release commit already exists; skipping."
  else
    git commit -m "release: v${version}"
    success "Created release commit"
  fi
}

step_stable_tag_and_push() {
  local version
  version=$(get_state "version")
  local notes
  notes=$(get_state "release_notes")
  local tag="v${version}"

  info "Creating annotated tag ${BOLD}${tag}${RESET}..."
  echo -e "$notes" | git tag -a "$tag" -F -

  info "Pushing commit and tag to origin..."
  git push
  git push origin "$tag"

  echo ""
  success "Stable tag ${tag} pushed!"
  echo ""
  echo -e "  ${DIM}CI will:${RESET}"
  echo -e "    1. Run tests / lint / typecheck / build"
  echo -e "    2. Build, sign + notarize bin/apple-fm-helper on a macOS 26 runner"
  echo -e "    3. Create a GitHub Release for ${tag}"
  echo -e "    4. Publish to npm@latest with --provenance (helper bundled)"
  echo ""
  echo -e "  ${DIM}Monitor:${RESET} https://github.com/brianwestphal/apple-fm/actions"
}

step_beta_tag_and_push() {
  local version
  version=$(get_state "version")
  local notes
  notes=$(get_state "release_notes")

  local beta_num=1
  while git rev-parse "v${version}-beta.${beta_num}" >/dev/null 2>&1; do
    beta_num=$((beta_num + 1))
  done
  local beta_tag="v${version}-beta.${beta_num}"

  info "Creating beta tag ${BOLD}${beta_tag}${RESET}..."
  echo -e "$notes" | git tag -a "$beta_tag" -F -

  info "Pushing beta tag to origin..."
  git push origin "$beta_tag"

  echo ""
  success "Beta tag ${beta_tag} pushed!"
  echo ""
  echo -e "  ${DIM}CI will:${RESET}"
  echo -e "    1. Run tests / lint / typecheck / build"
  echo -e "    2. Build, sign + notarize bin/apple-fm-helper on a macOS 26 runner"
  echo -e "    3. Create a GitHub Release flagged ${BOLD}prerelease: true${RESET}"
  echo -e "    4. Publish to npm with --tag beta --provenance"
  echo ""
  echo -e "  ${DIM}This is a beta — there is no auto-promote.${RESET}"
  echo -e "  ${DIM}Users get it via:${RESET}  npm install apple-fm@beta"
  echo ""
  echo -e "  ${DIM}Monitor:${RESET} https://github.com/brianwestphal/apple-fm/actions"
}

# --- Main ---
main() {
  BETA_MODE=false
  for arg in "$@"; do
    case "$arg" in
      --beta) BETA_MODE=true ;;
    esac
  done

  echo ""
  if [[ "$BETA_MODE" == "true" ]]; then
    echo -e "${BOLD}  apple-fm Beta Release${RESET}"
    echo -e "  ${DIM}--beta mode: tag-only, no version-file bump.${RESET}"
  else
    echo -e "${BOLD}  apple-fm Release${RESET}"
  fi
  echo ""

  init_state

  local resume_step
  resume_step=$(get_step)
  if [[ -n "$resume_step" && "$resume_step" -gt 0 ]]; then
    warn "Found saved progress (step ${resume_step}/8)."
    if confirm "Resume from where you left off?"; then
      echo ""
    else
      if confirm "Start over from scratch?"; then
        cleanup_state
        init_state
        resume_step=""
      else
        exit 0
      fi
    fi
  fi

  if ! past_step 1; then preflight; set_step 1; fi
  if ! past_step 2; then step_release_notes; set_step 2; fi
  if ! past_step 3; then echo ""; step_version; set_step 3; fi
  if ! past_step 4; then
    step_review
    if [[ "$BETA_MODE" == "true" ]]; then
      if ! confirm "Proceed with this BETA release?"; then
        warn "Aborted. State saved — run again to resume or edit."
        exit 0
      fi
    else
      if ! confirm "Proceed with this release?"; then
        warn "Aborted. State saved — run again to resume or edit."
        exit 0
      fi
    fi
    set_step 4
  fi

  if [[ "$BETA_MODE" == "true" ]]; then
    if ! past_step 7; then echo ""; step_local_checks; set_step 7; fi
    if ! past_step 8; then step_beta_tag_and_push; set_step 8; fi
  else
    if ! past_step 5; then echo ""; step_update_version; set_step 5; fi
    if ! past_step 6; then step_update_changelog; set_step 6; fi
    if ! past_step 7; then echo ""; step_local_checks; set_step 7; fi
    if ! past_step 8; then
      step_git_commit
      step_stable_tag_and_push
      set_step 8
    fi
  fi

  echo ""
  cleanup_state
}

main "$@"
