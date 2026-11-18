# Onboard storage and PC profiles

2026-11-16. Implementation: `src/main/onboard.cjs`, `src/main/protocol.cjs`. Research and automated tests did not access hardware. Any coordinated physical tests are recorded separately below or in `verification.md`.

## v2.4 mode-management update

**Superseded for page navigation in v2.5:** zero is now a portable preset executed on the PC, and all page choices are immediate without HID writes. The dedicated zero editor and `saveZeroPreset` enforce the portable compiler before PC-bank persistence. `applyZeroPreset` is a separate, hash-reviewed device write; the copy dialog likewise separates PC-bank saving from device recording. Explicit `importZeroPreset` reads direct device slots while retaining saved contents for app-trigger slots. Actual device writes still use the transaction guarantees below. See `pc-pages.md` for the current runtime behavior.

The compiler and low-level transaction contract below remain in use, but the production UI now routes uploads through `src/main/mode-manager.cjs`. Each device group has a durable zero bank under `%APPDATA%/mono-deck/onboard-banks/`, bound to the device serial and protected by a checksum. Initial capture preserves direct mappings, converts canonical app-only slots to empty bindings, and retains the common page-navigation knob. These files are separate from PC-profile exports.

**온보드 0 저장 / 읽기** merges reviewed compatible actions into the selected group's zero bank, preserves omitted bank slots, and applies that full group in onboard mode. It does not merge omitted slots from the currently active PC-trigger map. The common navigation knob cannot be overwritten. The production restore-app action likewise applies the entire selected group in PC mode, preserving its zero bank. The lower-level selected-slot methods illustrated below remain available for protocol tests and diagnostics, but are not the UI's v2.4 mode contract.

Ctrl+Alt+0 applies the last physically confirmed group's zero bank; Ctrl+Alt+1–9 and common-knob confirmation return that group to PC mode and select the requested page. PC-to-PC changes do not write device memory. Crossing the mode boundary stops macros, backs up mappings, writes only changed slots, and verifies selected payloads plus untouched groups. A durable pending journal is saved before writing. Readback can recognize a completed write after restart; partial failures require an explicit retry or recovery. The UI reports progress and blocks overlapping writes.

**기기 / 온보드 0 읽기** separates the actual device map from **보관된 온보드 0 읽기**, so a zero bank can be inspected while its group is in PC mode. A physical side-button change alone is not observable through the verified protocol; the common knob establishes the last confirmed group. Before using portable direct inputs on another PC, apply zero to the desired group. Closing the app or disconnecting does not automatically rewrite it. The common navigation knob still requires MONO DECK. See `pc-pages.md` and `verification.md` for behavior and the precise live-test coverage.

## What is stored where

| State | Storage and save operation | Other PC without MONO DECK |
| --- | --- | --- |
| App actions, profiles, names/icons, recorded workflows | `%APPDATA%/mono-deck/profiles.json`; explicit action/studio save | Not available from the keyboard alone |
| Direct keyboard/media bindings | Device slot; explicit reviewed onboard upload | Keyboard emits the configured standard HID input; interpretation depends on the receiving OS/app/layout |
| App connection signals | Device slot; input connection or restore-app-mode | Emits reserved F13–F24 combinations; does not carry the app action |
| Firmware RGB effect | Device layer; explicit lighting apply | Firmware handles the effect; power-cycle persistence still needs confirmation |
| Mapping recovery files | PC `backups/` directory; created before a write | Copy separately if recovery is needed on another PC |

The app editor uses a draft. Editing fields does not automatically save the action or upload anything. The action-save button and studio save commit the PC profile. Profile/layer selection, settings toggles and knob calibration persist when applied; the automatic-app process field persists on blur. A profile export copies PC configuration, not the device's firmware. Reading an onboard binding does not recover the PC profile, labels, recorded timing, or application paths.

For advanced macros on another Windows PC, transfer MONO DECK and the exported profile, import the profile, and enable execution after review. Target programs and paths must also exist there. The app must be running for PC actions, conditions, screen coordinates and recording playback. A portable direct binding does not require MONO DECK to emit its keyboard/media input, but a shortcut can have a different meaning in another OS or app.

## Supported portable subset

The upload compiler accepts:

- One ordinary keyboard key with Ctrl/Shift/Alt/Win modifiers, including right-side modifier bits.
- A keyboard-only sequence of at most 18 chords, without requested timing or repetition.
- Volume up/down, mute, play/pause, next/previous track and media stop.
- An explicit `none` action, encoded as an empty keyboard mapping.

F13–F24 are reserved for app connection signals and rejected in direct bindings, including inside sequences. A chord with two ordinary keys or modifiers alone is rejected. App execution, URLs, text/Unicode injection, mouse coordinates, raw key-down/up, recorded workflows, conditions, waits, repeats, speed changes and jitter are not silently converted. The preview lists each incompatible slot and blocks the entire upload. The user can explicitly select a smaller compatible set; no slot is skipped silently during a write.

In v2.3.1, a mixed selection shows separate supported and incompatible counts and lists. **불가능한 N개 제외하고 저장 준비** explicitly unchecks incompatible controls, preserves any existing manual exclusions, and recompiles the reduced selection. The upload button appears only for a fully compatible reviewed selection. Changing the destination or selected controls hides a mismatched review immediately. This preparation does not write hardware or edit the PC actions; **기기 레이어 N에 M개 슬롯 업로드** remains the separate write step. Everyday's default binding set has 19 portable controls and 5 PC-only controls (app launch and page navigation). Ctrl+C is portable even when the complete selection contains those PC-only controls.

Mouse records are recognized for read-only display when possible. Their limited firmware format is not an upload contract for the app's richer mouse actions. Unknown record types, usages, modifier-only records, and nonzero opaque bytes remain raw/read-only. An editable decoded action is exposed only if recompiling it reproduces every payload byte. This prevents an edit from discarding unexplained data.

Firmware delay is separate from the readable keyboard mapping. It is not reported as zero, reconstructed from action order, or overwritten with guessed values. Every read returns `timingKnown:false`. The preview warns that existing firmware timing cannot be read or guaranteed. No timing/firmware/layout configuration commands are sent by the portable implementation.

## Evidence and encoding boundary

The pinned primary [884x encoder](https://github.com/kriomant/ch57x-keyboard-tool/blob/bdbffca368f2084fbd111bc64463b881cd7c8fee/src/keyboard/k884x.rs) establishes long-header FE bindings: keyboard type 1, chord count at report offset 10, modifier/usage pairs starting at 11, and a maximum of 18 chords. Media type 2 stores a little-endian consumer usage at 11–12. The same source has a separate type-5 delay command, capped at 6000 ms; it does not establish delay readback. MONO DECK deliberately omits that write. Its tested FE finalize sequence remains unchanged. The [shared definitions](https://github.com/kriomant/ch57x-keyboard-tool/blob/bdbffca368f2084fbd111bc64463b881cd7c8fee/src/keyboard/mod.rs) supply keyboard usage ordering and consumer usages. Windows reports remain **65 bytes**, matching the attached device rather than the source's historical 64-byte buffer.

The supplied native artifact independently corroborates count/pair storage: retained REA evidence `ev_977a8080e13ab48b1ca2b4b20b3754fd696cf9dfaa2014f25ac12f5234d353a2`, function `0x40c9a0`, increments host-record offset 9 and writes each key usage at offset 11 + twice the previous count. Host records omit the report ID. Evidence was rechecked from `.local/vendor-analysis/rea-static-snapshot.json`; artifact SHA-256 `3b77babb3acb6fd73cdeddbd5aed724e28f12068db910e05c30a131966260b44`.

That vendor build uses FD staging, so it does not replace the FE path already validated on this device. Static evidence describes program construction, not successful firmware execution. The managed comparison artifact targets PID8890 and is not used as authority for writing this PID8840. See `vendor-analysis.md` for identities, coverage and decompiler limitations. Neither vendor executable was executed.

## API and transaction guarantees

```js
const {planOnboard} = require('./onboard.cjs');
const entries = [{layer:1, control:'key15', action:{type:'shortcut', keys:['CTRL','SHIFT','F12']}}];
const plan = planOnboard(entries); // Pure validation/encoding, no device access.
// Present plan.entries, plan.incompatible and plan.warnings before upload.
await keyboard.uploadOnboard(entries, {expectedHash:plan.hash});
const current = await keyboard.readOnboard(); // current.slots contains all 72.
await keyboard.restoreAppSlots([{layer:1, control:'key15'}]);
```

`planOnboard` returns `{ok, entries, incompatible, warnings, hash}`. Each supported entry includes slot identity, summary, sanitized action and encoded report. Entries are sorted by layer/slot; duplicates, invalid slots and empty requests are rejected. Upload independently recompiles the supplied actions and requires the reviewed hash. It cannot trust an edited report from the renderer.

`readOnboard()` returns `{ok, slots, readAt, timingKnown:false, lightingKnown:false}`. A slot includes `{layer, control, id, type, kind, summary, raw, appManaged, editable}` and an `action` only when safely editable. `kind:'app'` means the exact canonical app signal at its assigned slot, not a recovered macro.

Upload and individual app restore identify the supported device, read all 72 mappings, save a recovery file, and write only selected slots with the established commit sequence. They reread all 72, compare all selected payload bytes and require every unselected record to remain identical. Failures include the backup path and are not automatically retried. Mapping backups do not include all firmware delay/RGB state. Hardware writes are not assumed atomic if the connection fails partway through.

During a write, selected old app dispatch entries are removed. After reading, app dispatch requires an exact canonical signal at its assigned layer/slot. Reserved-trigger collisions from other keyboard chords or sequences disable the ambiguous signal. Thus portable input is not also executed as a PC macro. Returning selected slots to app mode restores their reserved signals; it does not delete their saved PC actions.

## Automated validation

`node --test tests/onboard.test.cjs tests/protocol.test.cjs`: **36 passed, zero failed**. All transport is fake. New tests cover packet fields and all supported media usages, 18/19-chord boundaries, incompatible semantics, reserved-trigger collisions, lossless decoding, opaque data preservation, deterministic preview hashes, selected-slot backup/write/read order, untouched-slot corruption, partial-write recovery messaging, and individual app restore.

Onboard execution on a second PC and behavior after power cycling must be observed before describing either as physically verified. Successful readback alone proves stored readable mapping bytes, not every target app's response.

## Coordinated physical transaction

### Sequence capacity bench probe (2026-11-16)

User-authorized device experiment: `scripts/probe-sequence-capacity.cjs`, evidence `.local/evidence/sequence-capacity.json`. MONO DECK was closed before direct HID access. All 72 records were backed up; layer 1/key 15 was temporarily written and restored after each sample. Eighteen distinct ordinary key usages round-tripped exactly. With nineteen, the count at offset 10 read back as 19, but the nineteenth usage at offset 48 read back as zero (sent 22); only the first eighteen modifier/usage pairs survived. Other 71 slots were unchanged in both samples. Final all-record SHA-256 matched the original. Testing stopped at this first lossy boundary; no larger or malformed reports were sent.

This establishes an 18-pair lossless boundary for the tested FE-write/FA-read path on this device. It does not establish the chip's absolute memory capacity, alternate protocol capabilities, power-cycle persistence, or actual emitted sequence length: no physical key was pressed during this experiment. In particular, accepting a count of 19 is not evidence of storing or executing nineteen valid keys. The production limit remains eighteen.

At `2026-11-16T07:43:43Z`, the root task temporarily uploaded Ctrl+Shift+F12 to layer 1, key 15 on the attached PID8840. Readback decoded an editable keyboard mapping with the expected modifiers/usage, and app-managed controls decreased from 72 to 71. The original mapping was immediately restored from the transaction backup; the count returned to 72 and the SHA-256 checksum of all 72 raw records matched the pre-test checksum.

Evidence: `.local/evidence/onboard-upload-read-restore.json`. Upload backup: `%APPDATA%/mono-deck/backups/mapping-DEVICE-2026-11-16T07-43-42-016Z.json`; restoration safety backup: `mapping-DEVICE-2026-11-16T07-43-42-873Z.json` in the same directory. This validates upload, device readback, decoding, dispatch ownership, backup restoration and complete mapping preservation. The physical key was not pressed during this test, and no second-PC or power-cycle test was performed.


## v2.3 read-screen usage

Open **키보드 저장 / 읽기 → 키보드 → PC 가져오기**. In **읽을 기기 레이어**, choose the large **1 / 2 / 3** button, then press **기기 레이어 N 읽기**. The selected memory layer is shown in the result heading and each row. The device side button does not need to change. **가져올 PC 위치** identifies the PC page and its binding set that will receive the staged import; the explicit PC-save step still applies. Reading uses the established read-all transport and filters the displayed layer. It never writes device mappings.
