# 5. Releasing

How apple-fm ships, and the **one-time setup** the CI release pipeline needs.
The actual cut is one command (`npm run release`); everything else is automated
in [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## The flow

```
npm run release            scripts/release.sh                GitHub Actions (release.yml)
  (or release:beta)   →    bump · changelog · commit    →    test/lint/typecheck/build
                           push tag  v1.2.3                   sign + notarize helper (macOS 26)
                                                              GitHub Release + npm publish
```

`scripts/release.sh` only prepares and **pushes a tag**. The tag push is what
triggers CI, which validates, builds + signs + notarizes the Swift helper, cuts
a GitHub Release, and publishes to npm.

- **Stable:** `npm run release` → tag `v{X}.{Y}.{Z}` → npm `latest`.
- **Beta:** `npm run release:beta` → tag `v{X}.{Y}.{Z}-beta.{N}` → npm `beta`
  (`npm install apple-fm@beta`); the version files are **not** bumped/committed.

CI on every push/PR is separate: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
runs the device-free unit suite on macOS runners (Node 20 + 22) and compiles the
Swift helper on a macOS 26 runner.

---

## One-time setup

> **Done.** This setup is complete and was **verified on the v0.1.0 release** —
> the `apple-fm` signing/notarization job and `npm-publish` both ran green and
> `apple-fm@0.1.0` shipped to npm. The steps below are kept as reference (e.g. for
> rotating secrets or bootstrapping a fork).

You need two things configured once: **npm trusted publishing** (so CI can
publish without a long-lived token) and the **Apple signing secrets** (so the
helper is Developer-ID-signed + notarized and runs on other Macs).

> All GitHub secrets below live at **GitHub → repo → Settings → Secrets and
> variables → Actions → New repository secret**. Names must match exactly.

### A. npm trusted publishing (OIDC)

No npm token is stored. npm trusts the GitHub workflow directly.

1. On npmjs.com → the **apple-fm** package → **Settings → Trusted Publishers →
   Add** (publish the package once manually first if it doesn't exist yet).
2. Fill in:
   - **Organization or user:** `brianwestphal`
   - **Repository:** `apple-fm`
   - **Workflow filename:** `release.yml`
   - **Environment:** `npm-publish`
3. In GitHub → repo **Settings → Environments → New environment** → name it
   exactly **`npm-publish`** (the `npm-publish` job references it). No secrets or
   protection rules are required, but you can add a required reviewer here if you
   want a manual gate before publish.

That's it — `release.yml` already requests `id-token: write` and runs
`npm publish --provenance`.

### B. Apple signing + notarization secrets

You need an Apple Developer account ($99/yr). Six secrets, gathered once.

#### B1. Developer ID Application certificate → `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_SIGNING_IDENTITY`

1. Create the cert (if you don't already have one): Xcode → **Settings →
   Accounts → Manage Certificates → + → Developer ID Application**. (Or via
   developer.apple.com → Certificates → +.) It lands in your login keychain.
2. Find its full identity name — this is `APPLE_SIGNING_IDENTITY`:
   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: Your Name (ABCDE12345)"
   ```
   Use the quoted string, e.g. `Developer ID Application: Your Name (ABCDE12345)`.
3. Export the cert **and its private key** as a `.p12`: Keychain Access → **My
   Certificates** → right-click the "Developer ID Application" cert → **Export** →
   `.p12`. Set an export password — that password is `APPLE_CERT_PASSWORD`.
4. Base64-encode the `.p12` for `APPLE_CERT_P12_BASE64`:
   ```bash
   base64 -i /path/to/DeveloperID.p12 | pbcopy   # now in your clipboard
   ```
   Paste it as the secret value.

| Secret | Value |
| --- | --- |
| `APPLE_CERT_P12_BASE64` | base64 of the exported `.p12` (step 4) |
| `APPLE_CERT_PASSWORD` | the `.p12` export password (step 3) |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` (step 2) |

#### B2. Team ID → `APPLE_TEAM_ID`

Your 10-character team identifier — the `ABCDE12345` inside the signing identity
above, or at developer.apple.com → **Membership details**.

| Secret | Value |
| --- | --- |
| `APPLE_TEAM_ID` | e.g. `ABCDE12345` |

#### B3. App-specific password → `APPLE_ID`, `APPLE_APP_PASSWORD`

Notarization with `notarytool` authenticates as your Apple ID using an
**app-specific password** (not your real password, and it sidesteps 2FA prompts
in CI).

1. Go to **https://appleid.apple.com → Sign-In and Security → App-Specific
   Passwords → Generate an app-specific password** (a.k.a. "+").
2. Label it something like `apple-fm notarytool` and copy the generated value
   (format `abcd-efgh-ijkl-mnop`). **You can't view it again** — regenerate if
   lost.

| Secret | Value |
| --- | --- |
| `APPLE_ID` | your Apple ID email (the account that owns the app-specific password) |
| `APPLE_APP_PASSWORD` | the generated `abcd-efgh-ijkl-mnop` app-specific password |

### Secrets checklist

All six are repository secrets:

- [ ] `APPLE_CERT_P12_BASE64`
- [ ] `APPLE_CERT_PASSWORD`
- [ ] `APPLE_SIGNING_IDENTITY`
- [ ] `APPLE_TEAM_ID`
- [ ] `APPLE_ID`
- [ ] `APPLE_APP_PASSWORD`

Plus the `npm-publish` GitHub **environment** and the npm **trusted publisher**
(section A).

---

## Cutting a release

```bash
npm run release          # stable
npm run release:beta     # beta / pre-release
```

The script walks you through release notes (drafted by `claude -p` if the
`claude` CLI is signed in, else a manual editor prompt), a version bump, a local
`typecheck → lint → test → build` gate, the changelog update + release commit,
and the tag push. It is **resumable** — a `.release-state.json` (gitignored)
remembers your progress, so a failed run picks up where it left off. Re-running
also lets you start over.

Then watch <https://github.com/brianwestphal/apple-fm/actions>.

## What CI does on the tag

1. **Validate** — `test` / `lint` / `typecheck` / `npm pack --dry-run` (macOS).
2. **`apple-fm` job (macOS 26)** — imports the Developer ID cert into a temporary
   keychain, `npm run build:helper` with `CODESIGN_IDENTITY` set (so the helper
   is signed), verifies the signature, notarizes via `notarytool --wait`, and
   uploads the binary as an artifact.
3. **`create-release`** — GitHub Release from the `CHANGELOG.md` section (stable)
   or the annotated tag body (beta).
4. **`npm-publish`** — downloads the notarized helper into `bin/`, builds, and
   `npm publish --provenance` (`--tag beta` for betas).

If the signing job fails or its secrets are missing, the publish still proceeds —
the package always ships the helper **source** plus
`scripts/build-apple-fm-helper.sh`, so installers can `npm run build:helper`
locally. Notarization is an enhancement, never a release blocker.

## Troubleshooting

- **`npm publish` 403 / OIDC error** — the trusted publisher (org/repo/workflow
  filename/environment) doesn't match, or npm < 11.5.1. The job upgrades npm; the
  usual cause is a mismatched workflow filename or environment name.
- **`notarytool` "invalid credentials"** — wrong `APPLE_ID` / `APPLE_APP_PASSWORD`
  / `APPLE_TEAM_ID`, or the app-specific password was revoked. Regenerate it
  (section B3).
- **`codesign` "no identity found"** — `APPLE_SIGNING_IDENTITY` doesn't match the
  cert in the `.p12`, or the `.p12` lacks the private key (re-export from
  Keychain Access **My Certificates**, not the cert alone).
- **Helper "did not build"** on the macOS 26 job — the runner image lacks the
  macOS 26 SDK / Xcode 26 (see [3-requirements.md](3-requirements.md) AF-12).
