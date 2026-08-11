# 09 — Competitive Landscape & Open Source vs Commercial

> Historical snapshot — written before the August 2026 rename to **AgentVoice**
> (see [`docs/26-rename-agentvoice.md`](./26-rename-agentvoice.md)). Left as
> "Cursor Voice" throughout to preserve the point-in-time record; the third-party
> `cursor-voice-cli` project mentioned below is unrelated to this repo either way.

Research snapshot: **June 2026**. Purpose: assess whether Cursor Voice duplicates
existing work, how mature alternatives are, and whether to pursue
commercialization or open source.

---

## Executive summary

| Question | Answer |
| --- | --- |
| **Is this duplicated effort?** | **Partially.** Many pieces exist separately (mobile + Cursor, voice + agents, Tailscale remote access). **No mature project matches the full stack:** speech-to-speech + `cursor-agent` headless MCP wrapper + Tailscale-only + non-technical-user UX for a family member. |
| **Closest threat** | **Cursor itself** (official mobile/cloud agents) and **Btelo Coding / KoeCode** (commercial mobile voice coding). **OpenClaw Nerve** is the closest *technical* analogue but targets a different agent stack. |
| **Commercial potential** | **Low–medium for a standalone product.** The market is crowded, Cursor is moving fast on mobile/cloud, and this design is optimized for a **personal/home use case**, not a mass-market SaaS. |
| **Recommended path** | **Open source (MIT/Apache) as a personal/small-team tool**, unless you want to productize *remote voice control for cursor-agent* as a niche developer utility — then consider a **dual-license or freemium relay** model like Btelo, not a from-scratch commercial play. |

---

## What Cursor Voice is (for comparison)

Distinctive combination:

1. **Non-technical end user** (dad) — not a developer "vibe coding"
2. **Speech-to-speech** (OpenAI Realtime / Gemini Live) — not STT → text chat → TTS
3. **`cursor-agent` headless** as sole executor, with **constrained MCP tools**
4. **Self-hosted bridge** on home machine, **Tailscale Serve** (no public relay)
5. **Project registry + sticky active project** for voice project selection
6. **"Cursor…" intent prefix** + latching push-to-talk

Most alternatives hit **1–2** of these, not all six.

---

## Open source & community projects

### Tier A — Most technically similar

| Project | Stars / maturity | Overlap | Gap vs Cursor Voice |
| --- | --- | --- | --- |
| **[OpenClaw Nerve](https://github.com/daggerhashimoto/openclaw-nerve)** | ~833 ⭐, active, polished docs | Voice (Talk Mode), WebRTC, OpenAI/Gemini realtime, **Tailscale Serve for iPhone mic**, push-to-talk, MCP/agent orchestration, kanban, workspace control | **OpenClaw ecosystem**, not `cursor-agent`. Much broader "agent fleet cockpit." Heavier install. Targets power users, not a non-technical parent. |
| **[mobile-computer-use](https://github.com/peytontolbert/mobile-computer-use)** | ~2 ⭐, App Store, early | iPhone/Android app, **`cursor-agent` CLI**, Codex, voice button (STT), local bridge, pairing | **Text chat + dictation**, not speech-to-speech. Developer UX. No MCP safety wrapper, no project registry, no Tailscale-first docs. |
| **[cursor-voice-cli](https://github.com/theDavidCoen/cursor-voice-cli)** | 0 ⭐, May 2026, very early | Voice + **`cursor-agent`**, wake word, continuous conversation, barge-in | **Linux desktop overlay** driving interactive TUI in tmux — not iPhone, not headless MCP, not remote. |

### Tier B — Voice layer for Cursor (IDE-side, not phone remote)

| Project | Maturity | What it does | Gap |
| --- | --- | --- | --- |
| **[echo-sound-coder](https://github.com/SamSammane/echo-sound-coder)** | Active, multi-client | MCP tools (`say`, `ask`, `listen`, `sfx`) for Cursor/Claude/Windsurf; voice Q&A while coding | Runs **inside the dev environment**, not remote iPhone control of headless agent |
| **[Spokenly](https://spokenly.app)** + MCP | Commercial + free MCP | `ask_user_dictation` — agent asks, you speak answer | Dictation input to IDE agent, not full voice agent orchestration |
| **[Dictare](https://github.com/dragfly/dictare)** | Early OSS | OpenVIP protocol, local STT, agent receives transcriptions | Local dev voice layer; no cursor-agent headless bridge |
| **[Codecall](https://github.com/TN0123/callcode)** | Extension | VS Code/Cursor extension, push-to-talk, ElevenLabs, spawns headless CLI | **At the desk** in the editor; multi-agent "call" UI for developers |

### Tier C — Mobile remote control (text-first)

| Project | Maturity | What it does | Gap |
| --- | --- | --- | --- |
| **[CursorRemote](https://github.com/len5ky/CursorRemote)** | Shipped, $7.99 one-time | Phone browser UI, approve/reject tool calls, CDP to local Cursor IDE | **IDE agent mode remote control**, text UI, developer-focused; no speech-to-speech |
| **[terminal-bridge](https://github.com/rajeshrout97/terminal-bridge)** | Small | MCP remote terminal for Cursor, Tailscale | Remote **shell**, not voice coding agent |
| **[openclaw-bridge-remote](https://github.com/lucas-jo/openclaw-bridge-remote)** | Small | MCP bridge over Tailscale for browser/shell | OpenClaw delegation, not cursor-agent voice |

---

## Commercial products

| Product | Model | Voice | Cursor / agent | Remote pattern | Target user |
| --- | --- | --- | --- | --- | --- |
| **[Btelo Coding](https://coding.btelo.com/)** | Freemium; PRO ~$10/mo | Hold mic, dictation | Claude Code, Codex, Gemini, **Cursor** | **Cloud relay** (zero-config) or self-host | Developers vibe coding from phone |
| **[KoeCode](https://koecode.ai/)** | Paid macOS/iOS apps | **Full duplex voice**, hands-free | **Claude Code** (not Cursor) | **Tailscale/VPN**, no relay | Developers walking away from desk |
| **[MobileCodeAI](https://mobilecode.ai/)** | TestFlight / commercial | Voice-to-PR | Multi-model mobile IDE | Cloud/mobile-native | Developers |
| **[VibeKit iOS](https://vibekit.bot/ios-ai-agent)** | SaaS + hosting | Voice call to agent | Own container agents | Their cloud + GitHub | App builders |
| **[VybeCoding](https://www.vybecoding.sh/)** | Freemium app | Voice → shell commands | SSH + AI tools on desktop | Desktop companion + SSH | Power users |
| **Cursor official** | Cursor subscription | Limited / text-first on mobile | **Native** cloud + local workers | **cursor.com/agents**, PWA, worker CLI | Developers |

**Btelo** and **KoeCode** are the strongest commercial comparables for "code from iPhone by voice." Neither is the same product:

- Btelo: developer chat UI + relay SaaS; voice is dictation into text prompts.
- KoeCode: closest **UX intent** (speak/hear, phone in pocket, Tailscale) but **Claude Code only**, Mac required, not an MCP-wrapped `cursor-agent`.

---

## Cursor official — the biggest "why build this?" question

Cursor now ships **web & mobile agents** ([blog](https://cursor.com/blog/agent-web)):

- `cursor.com/agents` from any phone browser / PWA
- **`agent worker start`** registers your machine as a worker
- Cloud agents with merge-ready PRs, Slack/GitHub integration
- Mobile is positioned for **approvals, follow-ups, background work** — still **developer-oriented, text-first**

**Implication:** For a technical user who only needs "prompt Cursor from my phone,"
**official Cursor mobile may be enough** and will keep improving. Cursor Voice
still differs if you need:

- A **non-technical** voice-only interface (no reading diffs/approvals)
- **Speech-to-speech** conversational refinement ("what did you mean by…?")
- **Hard MCP tool boundary** (not full agent autonomy)
- **Your projects on your home machine** without Cursor cloud VM economics
- **Polish/English** family workflow tuned to one person

---

## Duplication matrix

| Capability | Cursor Voice | Closest existing |
| --- | --- | --- |
| iPhone + mic over HTTPS | ✅ Tailscale Serve | Nerve, Btelo, Cursor PWA |
| Speech-to-speech (realtime model) | ✅ | Nerve (Talk Mode), KoeCode (Claude) |
| `cursor-agent` headless executor | ✅ | mobile-computer-use, Codecall, Btelo |
| Constrained MCP tool surface | ✅ | echo-sound-coder (different tools), terminal-bridge |
| Non-technical user UX | ✅ | **None found** — all targets assume developer literacy |
| Project registry + voice selection | ✅ | **None found** as first-class feature |
| Self-hosted, no relay SaaS | ✅ Tailscale-only | KoeCode (VPN), Nerve, CursorRemote |
| Git revert/diff via voice tools | ✅ | **None found** |

**Verdict:** Not a duplicate of any single project. It **overlaps heavily** with
Nerve + Btelo + KoeCode **slices**. The **unique value** is the **integration
targeting one non-technical user operating your projects via a bounded MCP layer**
— a narrow but real niche.

---

## Commercialization analysis

### Market signals (positive)

- Multiple paid products prove **willingness to pay** for mobile/voice coding control
- Btelo's relay SaaS shows a **freemium + PRO** model can work
- KoeCode shows premium for **voice-first + private connection**
- Cursor investing in mobile/cloud validates the category

### Headwinds (negative)

1. **Cursor is the platform** — they can absorb mobile, voice, and cloud workers into the subscription you already pay for.
2. **Crowded field** — Btelo, KoeCode, MobileCodeAI, VybeCoding, VibeKit, official Cursor.
3. **Narrow ICP** — "dad voices commands to son's cursor-agent on home PC" is not a scalable GTM story without repositioning to "voice remote for cursor-agent" broadly.
4. **Ops cost** — speech API bills, CLI beta breakage, iOS Safari quirks, support burden.
5. **Relay vs self-host** — commercial products often need a **relay** for zero-config; your design deliberately avoids that (Tailscale), which is great for privacy but bad for mass-market onboarding.
6. **Apple App Store** — native app path adds review, IAP, 15–30% cut (Btelo uses this).

### Realistic commercial models (if you chose to monetize)

| Model | Fit | Notes |
| --- | --- | --- |
| **Open source, no monetization** | ★★★★★ | Best fit for personal/family tool; community may contribute |
| **Open core + optional hosted relay** | ★★★☆☆ | Like Btelo self-host docs; you'd compete with Btelo on Cursor support |
| **One-time license (CursorRemote style)** | ★★☆☆☆ | Works for developer tools; weak for speech-to-speech (ongoing API costs) |
| **Subscription for hosted bridge + support** | ★★☆☆☆ | Needs relay infra, support, multi-tenant security |
| **Consulting / custom deploy for families/small teams** | ★★★☆☆ | Honest niche: "install voice control for your home dev box" |

### Recommendation

**Develop as open source** unless you explicitly want a **product business**.

Reasons:

1. **Primary user is family** — optimize for reliability and control, not ARR.
2. **Security model** (Tailscale + app token + MCP boundary) fits **self-host OSS** better than multi-tenant SaaS.
3. **Maintenance** tracks a **beta CLI** — community help and transparency help more than a paywall.
4. **Commercial competitors already exist** for the developer-voice-mobile segment; you'd be late without a sharp wedge.

If open sourcing:

- **License:** MIT or Apache 2.0 (matches similar projects: cursor-voice-cli, terminal-bridge, Nerve).
- **Positioning:** *"Self-hosted voice bridge for cursor-agent — built for hands-free and non-technical operators."*
- **Optional later:** accept sponsorships or paid "setup call" — not a full SaaS on day one.

If commercializing anyway, the only credible wedge is:

> **"The only speech-to-speech, MCP-bounded, Tailscale-private remote for cursor-agent"**

…aimed at **developers who want KoeCode-like UX but for Cursor on their own machine** — a smaller market than Btelo's, but differentiated.

---

## Strategic options (pick one)

### Option 1 — Build Cursor Voice (recommended if dad is the goal)

Proceed. Duplication is **partial**; official Cursor mobile won't give dad a
natural voice conversation with guardrails. Accept that you maintain a thin
integration layer over a moving CLI.

### Option 2 — Fork/adapt OpenClaw Nerve

If you adopt OpenClaw anyway, Nerve already has voice + Tailscale + WebRTC.
You'd still need a **cursor-agent adapter** — possibly *more* work, not less,
unless you're all-in on OpenClaw.

### Option 3 — Use Btelo + voice dictation

Fastest path for **developer** phone → Cursor on your machine. Not
speech-to-speech, not non-technical UX, uses their relay (privacy tradeoff).

### Option 4 — Wait on Cursor official voice

Low effort, but **no timeline** for conversational speech-to-speech for local
workers, and unlikely to optimize for non-technical users.

---

## Bottom line

- **Not wasted effort** for the stated goal (dad → your projects → voice → bounded agent).
- **Not a greenfield market** — expect overlap and fast official Cursor movement.
- **Open source is the rational default**; commercialization only makes sense if
  you reposition toward developers and accept competing with Btelo/KoeCode on
  distribution and polish.
