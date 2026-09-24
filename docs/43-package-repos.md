# 43 — apt and dnf repositories on GitHub Pages

> Added: September 2026. Step 4 of the plan in
> [`38-system-packages.md`](./38-system-packages.md): the .deb / .rpm packages
> that each release attaches are also served from signed apt and dnf
> repositories, so `apt upgrade` / `dnf upgrade` pick up new releases.

Site: **https://dixonsolutions.github.io/AgentVoice/**

| URL | What |
| --- | --- |
| `/apt` | apt repository — suite `stable`, component `main`, `amd64` + `arm64` |
| `/apt/agentvoice.sources` | ready-made deb822 source for `/etc/apt/sources.list.d/` |
| `/rpm` | dnf repository — `x86_64` + `aarch64` |
| `/rpm/agentvoice.repo` | ready-made repo file for `/etc/yum.repos.d/` |
| `/agentvoice.asc` | the public signing key |
| `/manifest.txt` | sha256 + path of every published package (read back by the next publish) |
| `/` | a short page with the install commands below |

## Installing (users)

### Debian / Ubuntu

```bash
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL https://dixonsolutions.github.io/AgentVoice/agentvoice.asc \
  -o /etc/apt/keyrings/agentvoice.asc
sudo curl -fsSL https://dixonsolutions.github.io/AgentVoice/apt/agentvoice.sources \
  -o /etc/apt/sources.list.d/agentvoice.sources
sudo apt update
sudo apt install agentvoice
```

The `.sources` file is:

```
Types: deb
URIs: https://dixonsolutions.github.io/AgentVoice/apt
Suites: stable
Components: main
Architectures: amd64 arm64
Signed-By: /etc/apt/keyrings/agentvoice.asc
```

The one-line equivalent, for older apt or if you prefer `.list` files:

```bash
echo "deb [signed-by=/etc/apt/keyrings/agentvoice.asc] https://dixonsolutions.github.io/AgentVoice/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/agentvoice.list
```

The key is only trusted for this one repository (`signed-by`), never
system-wide — no `apt-key`, nothing in `trusted.gpg.d`.

### Fedora / RHEL

```bash
sudo curl -fsSL https://dixonsolutions.github.io/AgentVoice/rpm/agentvoice.repo \
  -o /etc/yum.repos.d/agentvoice.repo
sudo dnf install agentvoice
```

dnf shows the key's fingerprint and asks to import it on first use. The repo
file checks both the repository metadata (`repo_gpgcheck=1`) and every package
(`gpgcheck=1`):

```ini
[agentvoice]
name=AgentVoice
baseurl=https://dixonsolutions.github.io/AgentVoice/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://dixonsolutions.github.io/AgentVoice/agentvoice.asc
metadata_expire=6h
```

### Upgrading

Upgrades then come with everything else:
`sudo apt update && sudo apt upgrade`, or `sudo dnf upgrade`. These are also
the commands the Serve page and `agentvoice update` show on a package install
(`src/serve/installMode.ts`), which only work once the repository is
configured. A .deb / .rpm installed by hand from a GitHub Release upgrades from
the repository as soon as it is added — it is the same package name.

## How publishing works

`.github/workflows/package-repos.yml`, one job:

1. **Import the signing key** (`packaging/repos/import-signing-key.sh`) into a
   throwaway `GNUPGHOME`, preset the passphrase into gpg-agent, and prove every
   key can sign non-interactively. No key, a malformed key, a wrong passphrase
   or an expired key fails the run here, before anything is downloaded — the
   repositories are never published unsigned.
2. **Download the release's `.deb` and `.rpm`** from the GitHub Release(s)
   with `gh release download`.
3. **Fetch what the site serves now** (`packaging/repos/fetch-published.sh`):
   every package listed in `/manifest.txt`, each checked against its sha256. A
   404 on the manifest means nothing is published yet; any other failure stops
   the run, because carrying on would publish a repository that silently lost
   every older version.
4. **Build** (`packaging/repos/build-repos.sh`):
   - new RPMs are signed with `rpmsign`, and so is any already-published one
     the current key no longer verifies (a leftover from a previous key, see
     "Key rotation"); the rest are not touched, so their bytes never change;
   - keep the newest **3** versions (`KEEP_VERSIONS`), then drop the oldest
     until the packages fit **900 MB** (`SITE_BUDGET_MB`) — the newest version
     is never dropped;
   - apt: `apt-ftparchive` writes `Packages{,.gz}` per arch and `Release`,
     which is signed as `InRelease` (clearsigned) and `Release.gpg`
     (detached), SHA-512;
   - dnf: `createrepo_c` (gzip metadata, so EL8 can read it; no sqlite), and
     `repomd.xml` is signed as `repomd.xml.asc`;
   - writes `agentvoice.asc`, `agentvoice.repo`, `agentvoice.sources`,
     `manifest.txt` and `index.html`.
5. **Verify with only the public key**: `gpgv` on `InRelease`, `Release.gpg`
   and `repomd.xml.asc`; `rpmkeys --checksig` in a scratch rpmdb on every RPM,
   requiring `signatures OK` (an unsigned RPM only says `digests OK`).
6. **Deploy** with `actions/upload-pages-artifact` + `actions/deploy-pages`.

It runs:

- **On every release**, as the `repos` job at the end of
  `.github/workflows/npm-publish.yml`, after the deb/rpm job succeeded for
  *both* architectures. A release that did not ship (no version bump) never
  gets here.
- **By hand** — Actions → package-repos → Run workflow, or
  `gh workflow run package-repos.yml`:
  - `tags` empty: re-add the latest `v*` release;
  - `tags: "v0.1.1 v0.1.2"`: backfill several (useful on the very first
    publish);
  - `dry_run: true`: do everything except deploy.

Runs never overlap (`concurrency: package-repos`, never cancelled), because
each one reads back what the previous one deployed.

### Why deploy-pages, not a `gh-pages` branch

Each release is four ~70 MB packages. A `gh-pages` branch would put hundreds of
MB of binaries into every `git clone` and every plain `git fetch` of this
repository — and this repository is fetched constantly, by every worktree and
agent working on it — and it would hit GitHub's 100 MB per-file push limit as
soon as a package crossed it. A Pages artifact keeps all of that out of git.
The one thing a branch would give for free — the previous state, to keep older
versions — is read back from the live site instead (`manifest.txt` +
checksums), with a cache-busting query so the CDN's ~10-minute cache cannot
hand back a stale manifest.

### Limits

- **GitHub Pages sites are capped at 1 GB**, hence 3 versions and the 900 MB
  budget. If packages grow, the budget keeps fewer versions automatically; if a
  single version ever exceeds it, the run fails rather than publish a broken
  site. Every version stays downloadable from its GitHub Release regardless.
- Pages has a soft **100 GB/month** bandwidth limit — roughly 1,400 package
  downloads a month. Past that, move the repositories to a CDN-backed host
  (Cloudflare R2, Cloudsmith, packagecloud); the scripts do not care where the
  tree is served from, only `SITE_URL` changes.

## One-time setup (maintainer)

### 1. Create the signing key

On a trusted machine, into a throwaway keyring so the key never touches your
everyday one:

```bash
export GNUPGHOME="$(mktemp -d)"
gpg --quick-generate-key "AgentVoice Packages <REPLACE-WITH-MAINTAINER-EMAIL>" rsa4096 sign 3y
fpr="$(gpg --list-secret-keys --with-colons | awk -F: '$1=="fpr"{print $10; exit}')"
echo "$fpr"

gpg --armor --export-secret-keys "$fpr" > agentvoice-signing.key.asc   # private
gpg --armor --export "$fpr" > agentvoice.asc                           # public
cp "$GNUPGHOME/openpgp-revocs.d/$fpr.rev" agentvoice-signing.rev        # revocation certificate
```

RSA-4096 rather than Ed25519: every apt, rpm and crypto policy still in
support verifies RSA, while EdDSA support in older rpm releases and some
distro crypto policies is patchy. gpg asks
for a passphrase; use one (it becomes a secret below) or press Enter twice for
none.

### 2. Store it as repository secrets

```bash
gh secret set PACKAGE_SIGNING_KEY --repo dixonSolutions/AgentVoice < agentvoice-signing.key.asc
gh secret set PACKAGE_SIGNING_PASSPHRASE --repo dixonSolutions/AgentVoice   # prompts; skip if no passphrase
```

Then move `agentvoice-signing.key.asc` and `agentvoice-signing.rev` to offline
storage (a password manager or an encrypted USB stick), and remove the working
copies:

```bash
shred -u agentvoice-signing.key.asc agentvoice-signing.rev
gpgconf --kill gpg-agent && rm -rf "$GNUPGHOME"; unset GNUPGHOME
```

### 3. Turn on GitHub Pages, deployed from Actions

Settings → Pages → Build and deployment → Source: **GitHub Actions**. Or:

```bash
gh api -X POST repos/dixonSolutions/AgentVoice/pages -f build_type=workflow
```

This creates the `github-pages` environment, which by default only deploys
from the default branch. Releases from `main` (push or `workflow_dispatch`)
are fine. Releases cut by pushing a `v*` tag run on the tag ref and would be
refused; to allow them too:

```bash
gh api -X POST repos/dixonSolutions/AgentVoice/environments/github-pages/deployment-branch-policies \
  -f name='v*' -f type=tag
```

### 4. First publish

Backfill the releases that already exist, dry run first:

```bash
gh workflow run package-repos.yml --ref main -f tags="v0.1.1 v0.1.2" -f dry_run=true
gh workflow run package-repos.yml --ref main -f tags="v0.1.1 v0.1.2"
```

From then on every release publishes itself.

## Key rotation

**Extending the expiry** (before it lapses — an expired key fails the import
step, so nothing publishes):

```bash
gpg --import agentvoice-signing.key.asc          # into a throwaway GNUPGHOME, as above
gpg --quick-set-expire "$fpr" 3y
gpg --armor --export-secret-keys "$fpr" | gh secret set PACKAGE_SIGNING_KEY --repo dixonSolutions/AgentVoice
```

The next publish serves the updated `agentvoice.asc`. Users hold a copy of the
old one, and apt refuses an expired key, so they refresh it once:

```bash
sudo curl -fsSL https://dixonsolutions.github.io/AgentVoice/agentvoice.asc -o /etc/apt/keyrings/agentvoice.asc
sudo rpm --import https://dixonsolutions.github.io/AgentVoice/agentvoice.asc   # dnf
```

Announce it in the release notes before the old expiry date.

**Replacing the key** (compromise, or moving to a new one): generate a new
key as in step 1, then set the secret to *both* private keys, **new first**:

```bash
cat new.key.asc old.key.asc | gh secret set PACKAGE_SIGNING_KEY --repo dixonSolutions/AgentVoice
```

With several keys in the secret, the apt `Release` files and `repomd.xml` are
signed by all of them (clients accept any signature from a key they trust),
new RPMs are signed with the first, and `agentvoice.asc` carries every public
key. Existing users keep working on the old key while they pick up the new
file; after a release or two, set the secret to the new key alone. On
**compromise**, skip the overlap: publish the new key alone, publish the
revocation certificate, and tell users to re-run the key download.

Either way, the first publish that no longer carries the old key signs the
packages still holding its signature again with the new one, so nothing the
site serves depends on a key that is not published any more.

## Testing it locally

The three scripts run anywhere with `apt-utils`, `createrepo-c`, `rpm` and
`gnupg`. With a throwaway key in a temporary `GNUPGHOME` and a directory of
packages:

```bash
export GNUPGHOME="$(mktemp -d)"
PACKAGE_SIGNING_KEY="$(cat test-key.asc)" packaging/repos/import-signing-key.sh
BASE_URL=http://127.0.0.1:8765 packaging/repos/build-repos.sh /tmp/site ./incoming
python3 -m http.server 8765 -d /tmp/site
```

and point an apt source (with `signed-by=`) or a `.repo` file at
`http://127.0.0.1:8765/…`.
