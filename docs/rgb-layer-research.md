# RGB and hardware-layer investigation

2026-11-16. Scope: source-backed RGB packet construction, supplied native/managed vendor artifacts, and safe multi-layer mapping APIs. This research agent's tests use fake HID only. The root task subsequently performed the coordinated physical validation recorded below.

## Confirmed on the attached A73T

At 2026-11-16T06:07:41.357Z, the root task successfully sent layer 3, press mode, cyan (`code=0x54`) to the attached `1189:8840`. All 72 key/knob mappings were reread and confirmed unchanged. The user then confirmed: **“누르면 청록색으로 반응함”** (pressing a key produces cyan feedback).

Evidence: `.local/evidence/rgb-press-test.json`; pre-write mapping backup `.local/backups/mapping-DEVICE-2026-11-16T06-07-40-914Z.json`. Thus pressed-key cyan feedback is physically verified on this unit. Hardware RGB readback and persistence after a power cycle remain unverified. Factory patterns 2/3 should retain generic UI labels until their actual effects are observed.

The root task subsequently provisioned layers 1 and 2 on the real device at 2026-11-16T06:20:05Z. The transaction verified all 48 selected records against the expected payload, preserved layer 3 exactly, and reported 72 distinct mapped controls. Evidence: `.local/evidence/layers-1-2-provisioned.json`; pre-write backup `%APPDATA%/mono-deck/backups/mapping-DEVICE-2026-11-16T06-20-05-705Z.json`. The user then physically selected layers 1 and 2 and pressed the upper-left key on each, confirming “둘 다 맞게 표시됨” (both displayed correctly). Thus representative physical switch selection and input delivery are confirmed on layers 1/2 as well as the previously tested layer 3; other slots/directions have not all been physically exercised.

## Implemented API

`src/main/protocol.cjs` now provides:

```js
await keyboard.provision();                 // unchanged default: layer 3
await keyboard.provision([1, 2, 3]);
await keyboard.restore(backupFile);          // unchanged default: layer 3
await keyboard.restore(backupFile, [1, 3]);
await keyboard.refresh();                   // reads all 72 controls
await keyboard.setLighting({
  layer: 3,
  mode: 'press',
  color: 'cyan'
});
```

Layer lists must be a nonempty, duplicate-free subset of numeric 1, 2, 3. Invalid requests fail before device access. Provision and restore back up all 72 mappings, write only selected layers, read all 72 again, compare every selected payload byte, and ensure every unselected record is unchanged.

The modifier families deliberately retain the previous layer-3 triggers:

| Hardware layer | Controls 1–12 | Controls 13–24 |
| --- | --- | --- |
| 1 | Ctrl+F13–F24 | Ctrl+Shift+F13–F24 |
| 2 | Ctrl+Alt+F13–F24 | Ctrl+Alt+Shift+F13–F24 |
| 3 | F13–F24 | Shift+F13–F24 |

Each `inputMap` value is now `{control, layer}`. Duplicate fingerprints across any layer are removed to prevent ambiguous dispatch. `status.layers[1..3]` reports `{provisioned, mappedControls}`; legacy top-level `provisioned` and `mappedControls` continue describing layer 3. `totalMappedControls` counts all unambiguous controls.

The app's selected editing layer does not prove which physical layer is currently active. A uniquely mapped input identifies the hardware layer that emitted that input.

## RGB format established

The 65-byte Windows HID report includes report ID 3. Lighting uses:

```text
03 FE B0 layer 08 00 00 00 00 00 01 00 code [zero padding to 65]
03 FD FE FF                              [zero padding to 65]
```

- Layer is 1–3.
- `code` is at **report offset 12**, not 10.
- A colored effect uses `(color << 4) | mode`.
- One setting applies to a layer. There is no per-key index in this established RGB packet.
- The keyboard firmware implements pressed-key feedback; the app does not need to stream one flash per key event.

Supported input enums:

| API mode | Wire low nibble | Intended behavior / limitation |
| --- | ---: | --- |
| `off` | 0 | Code normalized to 00 regardless of color |
| `backlight` | 1 | Constant selected color |
| `shock` | 2 | Factory pattern 2; visual descriptions vary across ports |
| `shock2` | 3 | Factory pattern 3; visual descriptions vary across ports |
| `press` | 4 | Firmware lights the pressed key |
| `backlight` + `white` | 5 | Special whole code 05 |

| Color | High-nibble value |
| --- | ---: |
| red | 1 |
| orange | 2 |
| yellow | 3 |
| green | 4 |
| cyan | 5 |
| blue | 6 |
| purple | 7 |

White is admitted only for off/constant-backlight, following the established primary encoder. Arbitrary RGB hex values, per-key colors, speed, brightness, and unrecognized fields are rejected. They have no established encoding for this unit.

### Native artifact corroboration

The supplied native `MINI_KEYBOARD.exe` is bound to SHA-256 `3b77babb3acb6fd73cdeddbd5aed724e28f12068db910e05c30a131966260b44`.

- Function `0x443750` copies 218 bytes from `0x480020` to the widget lookup table at `this+0x7f8`.
- Table indices 83–89 contain `10 20 30 40 50 60 70`; indices 90–95 contain `00 01 02 03 04 05`.
- The same constructor installs color names Red, Orange, Yellow, Green, Cyan, Blue, Purple in numerical order and labels effects only “LED Mode0” through “LED Mode5.”
- Function `0x40cd80` constructs FE B0, layer+1, count 1, masks and combines high/low nibbles, and stores the packed byte at host-record offset 11 (wire offset 12).
- The native function defaults a missing color nibble to cyan. The standalone encoder uses the primary Rust semantics for off (00) and constant white (05), rather than copying the vendor UI's current-color-dependent behavior blindly.

Evidence IDs:

| Observation | REA evidence |
| --- | --- |
| Native color/mode byte table | `ev_8cbf301a40f4aca513a191313155624b1e6bcf8a0bbfab2aa988247317c7d9eb` |
| Constructor copying table | `ev_7b6c10f4f62f4efc003ded966e7c354fb25a7921422a601ad94798f1aeeabbb1` |
| RGB function dossier with assembly | `ev_25ac2d6b71378fbe13c126b38c5e1b5e76131a7f4e441ad1a0a716bc4c3128a0` |
| RGB function pseudocode | `ev_463ca4c0f7432b59358eb3927baaa3ce1d505befb0414c42011b10c914deae00` |
| English color and mode labels | `ev_08bffdba501ef0787429c61e92b795029b3db953f20c23360b92d492d8d82720` |
| Chinese labels (also generic mode numbers) | `ev_c53a002fc05921a0273e68e75377e97ed7802088b5330ba778089edf16af83a7` |

These are static observations, not runtime execution. Ghidra pseudocode has imperfect type recovery; the RGB opcode, masks, count, and packed-byte destination were checked in assembly.

### Primary source cross-checks

The exact FE B0/type-8 packet, color table, off normalization, white special case, and mode mapping are implemented by [kriomant/ch57x-keyboard-tool, pinned k884x.rs](https://github.com/kriomant/ch57x-keyboard-tool/blob/bdbffca368f2084fbd111bc64463b881cd7c8fee/src/keyboard/k884x.rs). Its effects 2 and 3 are named shock/shock2.

[Mun1to/hotkeyconfig's protocol notes, pinned](https://github.com/Mun1to/hotkeyconfig/blob/525391ff3cc2dd62b6f032d7bf630a09ae71b689/docs/PROTOCOL.md) independently document Windows 65-byte framing, code offset 12, and the layer-wide nature of this RGB command. It distinguishes firmware pressed-key illumination from software-driven whole-keyboard feedback. Its tested unit is PID8842, so it corroborates the family rather than this individual pad.

[Palanx/CH57x-Whisperer's pinned protocol](https://github.com/Palanx/CH57x-Whisperer/blob/559831058ae5af96823d1f5cad8a6f7c562fb81c/Sources/ch57x-whisperer/Protocol.swift) targets PID8840 and reports that 65-byte reports plus an FB/FA query preamble on the same open session were needed for its LED setting to survive a power cycle. That implementation labels effects 2/3 as breathing variants, illustrating why the UI should avoid promising an exact animation until this pad is observed.

## Persistence and verification boundary

`setLighting` validates options first, enters the existing exclusive HID session, performs the FB identity exchange and FA reads for all three layers, saves a mapping backup, writes the LED record and one commit, then rereads all 72 mappings and checks they are unchanged. It waits 30 ms after each write and 200 ms after committing.

This reproduces the meaningful **same-session query-before-write structure** reported by the PID8840 port. That port also includes trailing 01/7F bytes attributed to uninitialized vendor memory. Those additional bytes have no established semantics on the attached unit and are not copied into MONO DECK's already validated read commands.

There is no established RGB readback in the current implementation. Therefore:
- A successful result establishes complete transport writes and unchanged key/knob mappings.
- `result.lighting.readbackVerified` and `persistenceVerified` remain false.
- `status.lighting[layer]` records the **last requested** setting with `sentAt`; it is not presented as device-read lighting state.
- The mapping backup does not contain the prior LED setting and cannot restore it.
- Confirm color/effect physically, then unplug/reconnect to verify persistence before asserting it.

No per-key RGB streaming, custom frame animation, or per-keystroke EEPROM writes are implemented. Native press mode is the correct first implementation for “lights when pressed.”

## Hardware layer switching: managed artifact is another protocol

The similarly named managed `MINI KeyBoard.exe` has SHA-256 `4ae53d3a40921e4f57444c489fa1b38fe91a2e907feda17630450fc97a7cd7b1`, MVID `830e3432-592a-4fe8-a60e-4e46348e689c`.

Its `FormMain.Send_SwLayer` method (token `0x0600003b`, file method-header offset 6240, 96-byte IL body beginning at 6252) builds a payload starting **A1, selectedLayer**, substitutes 1 for selectedLayer=0, then sends it with a separate ReportID field. IL SHA-256 `724474e85e29bdd7b9fc86e9df37fb1b3079578286a4d947d560e60f1262f471` was checked directly against file bytes.

Crucially, `FormMain.AutoCheckUsb` contains VID decimal 4489 (1189 hex) and PID decimal 34960 (**8890 hex**). Thus A1 is evidence for a different target generation, **not authority to send A1 to this PID8840**. No speculative layer-switch command was added.

Managed evidence:
- Selected types and canonical CIL member evidence: `ev_7c62d65e8ae2b0547661d591b1c98b0c93e7b04cdc7fa1b35172c42e666b09b0`
- Method bodies including AutoCheckUsb and Send_SwLayer: `ev_f719529702e88cbf151dff4e647c29ad91d144bd29ad7d1371b88aac86c494fc`
- Field identities including KEY_Cur_Layer and ReportID: `ev_a1d218d7854240e60323dbf063be70d23d4e2b9397426af09aa6e63a11b87870`

The native artifact's SendLayer handler was previously shown to change host editing state; see [vendor-analysis.md](vendor-analysis.md). The [PID8840 port's README](https://github.com/Palanx/CH57x-Whisperer/blob/559831058ae5af96823d1f5cad8a6f7c562fb81c/README.md) also directs users to the physical layer switch. MONO DECK exposes editable/provisionable layers and distinguishes them via unique inputs, while physical active-layer switching remains on the device.

## Tests and retained evidence

`node --test tests/protocol.test.cjs`: **22 passed** after implementation. Tests substitute node-hid before importing the protocol module, preventing real device access.

New tests cover 72 unique triggers, cross-layer ambiguity removal, selection rejection before HID access, exact multi-layer write/restore verification including opaque tail bytes, all-layer refresh, RGB field packing for all supported colored combinations, white/off special cases, unsupported-option rejection, mapping-preserving RGB transaction order, short-write abort, and mutation detection.

The REA native session was successfully closed. Additional snapshot: `.local/vendor-analysis/rgb-layer-snapshot.json` (6,913,323 bytes, 49 evidence records). It preserves eligible retained observations and is not recovered source or a complete Ghidra project.
