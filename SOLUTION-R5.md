# Round 5 — Upstream Check + Experimental Android Pipeline (Chain Capture, Picker Position, Single-Image Guard)

**Base:** `Vali-98/ChatterUI@dev` commit `3cc78f9` + R1–R4 (all confirmed working by device testing)
**Verified:** `tsc --noEmit` 0 errors (workspace AND pristine clone at `3cc78f9` + CHANGES.diff), ESLint 0 errors on all touched files, `drizzle-kit check` OK, **PickerChain validated against a 9-case simulated Android-hardness harness (all pass)**

---

## 1. Upstream check (6 days elapsed) — YES, mainline moved. Do NOT rebase yet.

Upstream `dev` gained **13 commits** since our base `3cc78f9` (checked 2026-08-29 against github):

```
51ebf7b i18n: use libretranslate            f88489a fix: styling
f3007e3 fix: i18n                           eb74171 fix: reorder default case
c661eb7 chore: release beta                 555a7d3 feat: lorebook preferences
e7ea01e feat: lorebook key data             7c4a438 feat: lorebooks
43857dc chore: release 0.10.0-beta4         e6048ca feat: show file magic on import
a5bd9a2 fix: updated deps                   207a982 fix: incorrect size tag
7479d3f fix: cleanup
```

**Findings that matter to us:**

1. **⚠️ MIGRATION NUMBER COLLISION (blocking for any future rebase):** upstream now has its own migration `0021_productive_nebula` (lorebook schema rework) at journal idx 21 — the same slot as our `0021_glorious_ultron` (attachment sha256/width/height). A naive merge would corrupt the migration journal on-device. When you decide to rebase onto the new upstream, our migration must be **renumbered to 0022** (new tag, journal idx 22, snapshot regenerated via `drizzle-kit generate`) and devices that already applied our 0021 will need a transitional guard. This is mechanical but must be done deliberately — **this round therefore stays based on `3cc78f9`**, which is exactly what your tested-good build is.
2. `AddConnection.tsx` was **deleted** upstream (connection creation is now TemplatePicker-only) — our R4 default-model fix there would become obsolete on rebase; the TemplatePicker path already spreads `defaultValues` correctly.
3. Upstream `File.ts` gained `readFileMagic` (no conflict with our helpers — different functions), `Logger.errorToast` now accepts `unknown` (parallel to our `formatError`, compatible), and the `console.log('tts')` debug spam we'd noticed was removed.
4. Nothing upstream touches the generation registry, SSE, ChatInput, or the Vision pipeline — **no functional overlap with our mod**; the only true conflict is the migration slot.

**Recommendation:** keep building on `3cc78f9` until you want lorebooks; then do a dedicated rebase round handling the 0021→0022 renumber.

## 2. New: Experimental — Android pipeline (Settings → Vision & Attachments)

Three additions, **all OFF by default**, under a new "Experimental — Android pipeline" divider.

### 2.1 Chain Capture (2-press loop) — gated on all three base toggles

The full vision job becomes **two button presses**: tap an image → tap OK → the image sends, a fresh conversation opens, and the picker is automatically back in front of you. Repeat. Press back/cancel in the picker to exit the loop.

- **Hard gate, exactly as specified:** the toggle only functions when **Disable Camera + Send when Attached + Switch Context on Send are all ON**. In settings the switch is inert and shows the gate requirement while any of the three is off; at runtime the gate is re-read from live settings **at every chain step**, so flipping any toggle mid-loop stops the chain.
- **Architecture:** new `lib/utils/PickerChain.ts` — a dependency-free state machine driving pick → (auto-send via existing R3/R4 pipeline) → deferred relaunch. `pickImageOnce` now returns a typed outcome (`sent` / `canceled` / `blocked` / `attached`), and only `sent` continues the chain.
- **Android hardness engineered for, and simulated off-device (9-case harness, all passing):**
  | Case | Behavior verified |
  |---|---|
  | Happy chain ×3 then cancel | strictly sequential picks, cancel exits |
  | Cancel on first pick | zero relaunches — back/cancel is ALWAYS the exit |
  | Launch throws once (host activity not yet resumed after the previous picker — the classic Android relaunch race) | 600 ms deferred relaunch + one retry after 1.2 s succeeds |
  | Launch throws persistently | chain gives up after max retries, no spin |
  | Double-tap attach while picker in flight | re-entrancy guard → single pick |
  | Gate toggled off while relaunch timer pending | timer fires, gate re-checked, no relaunch |
  | Screen unmount while timer pending | `dispose()` cancels — nothing fires into a dead screen |
  | Guard-blocked send | chain stops (no send → no loop) |
  | 30-iteration chain | timer-scheduled (no recursion), max concurrency = 1 |
- Failed sends, permission denials, and single-image-guard refusals all map to `blocked` → the chain never loops on failure.

### 2.2 Remember last picker position (checkbox)

The modern Android 13+ Photo Picker (`PickVisualMedia`) is a **system activity that always reopens at Recents** — apps cannot influence its scroll state at all (verified in the expo-image-picker native contract source: it builds a `PickVisualMediaRequest`; no position API exists). The only mechanism Android offers is the **legacy `ACTION_GET_CONTENT` gallery picker**, whose DocumentsUI/gallery provider keeps its own browsing position (month, album — your "July, June" scroll) across launches within a session.

The checkbox sets `legacy: true` on `launchImageLibraryAsync` — expo's contract then builds the `ACTION_GET_CONTENT` intent (with `EXTRA_ALLOW_MULTIPLE` preserved, verified in `ImageLibraryContract.kt`). Trade-off stated in the description: the legacy picker has the older UI. Fully independent of the other toggles; stacks cleanly with Chain Capture for long historical batch sessions.

### 2.3 Guard against multi-image sends (checkbox)

Two enforcement layers:
- **Send-time (authoritative):** `handleSend` counts image attachments on **every** path — manual tap, Send-when-Attached, chained sends, queue — and refuses with a toast naming the count ("Single-image guard: 3 images attached — remove extras to send"). Nothing is cleared: remove extras via the ✕ on thumbnails and send again.
- **Pick-time (preventive):** the picker launches in single-select mode (`allowsMultipleSelection: false`, `selectionLimit: 1`) so the modern Photo Picker enforces the limit natively before the guard ever needs to fire. Note the legacy picker (2.2) cannot enforce a hard native limit — `EXTRA_ALLOW_MULTIPLE` is simply omitted, and the send-time guard remains the backstop, which is exactly why the guard exists at send level.

`handleSend` now returns `boolean` (dispatched vs blocked) — this is also what feeds the chain's outcome logic.

## 3. Integration notes

- `pickImageOnce`/gate flags are threaded through refs updated in an effect, and the `PickerChain` instance is created lazily **inside the event handler** — satisfies the React Compiler ref rules (no ref reads/writes during render), and one controller per mounted ChatInput is disposed on unmount.
- Attachment metadata cascade, mime rectification, sha256/dims (R2), and the parallel per-swipe generation registry (R3) are untouched — chained sends ride the exact same `handleSend` path your testing validated.

## 4. Files changed this round

| File | Change |
|---|---|
| `lib/utils/PickerChain.ts` | **new** — chain state machine (harness-tested) |
| `app/screens/ChatScreen/ChatInput/index.tsx` | outcome-returning pick, chain wiring, single-image guard, legacy-picker flag, boolean handleSend |
| `app/screens/AppSettingsScreen/VisionSettings.tsx` | Experimental section: gated Chain Capture switch + two checkboxes |
| `lib/constants/GlobalValues.ts` | ChainCapture / RememberPickerPosition / SingleImageGuard (all default false) |
| `i18n/locales/en.json` | labels, descriptions, gate hint, guard toast |

`CHANGES.diff` is the **cumulative R1–R5** diff vs `3cc78f9` — verified to apply cleanly and typecheck on a pristine clone of that commit.

## 5. Device verification

1. Settings → Vision & Attachments: "Experimental — Android pipeline" divider with the three new controls, all off. Chain Capture switch is inert (with explanation) until the three base toggles are on.
2. **Two-press loop:** enable all four → paper-clip → tap image → OK. Expect: send fires, new chat opens, picker reappears (~0.6 s). Tap image → OK again. Press back → loop ends, you're in the newest empty chat. Logs: one send per round, no `[ChainCapture]` warnings.
3. **Position memory:** enable the checkbox → picker is the classic gallery. Scroll to July, pick, OK; when the picker returns (chained or manual) it is still at July. Disable → modern picker returns, reopening at Recents (system behavior).
4. **Guard:** enable checkbox, attach 2+ images with auto-send off, tap Send → toast, nothing sent; remove one → sends. With guard on, the modern picker only allows single selection. Legacy + guard: multi-select possible in UI, but send refuses — expected, documented.
5. Mid-loop toggle test: while the picker is up in a chain, background the app, disable Send when Attached, return, pick → image attaches but does not send, chain ends.
