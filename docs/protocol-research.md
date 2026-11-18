# CH57x 1189:8840 protocol research

Research date: 2026-11-16. Scope: source-level protocol analysis; no device writes or firmware extraction were performed by the research worker. This is not an REA native-binary session, so there are no REA Evidence IDs. The parent investigation owns the local device captures.

## Identity and confidence

- **Locally observed by the parent:** Windows enumerated `USB\\VID_1189&PID_8840\\<device-instance>`, a vendor-defined HID interface `MI_00`, and keyboard/consumer collections on `MI_01`.
- **User supplied:** 15 ordinary keys and three knobs, one large and two small.
- **Strong external corroboration:** upstream issue [#172](https://github.com/kriomant/ch57x-keyboard-tool/issues/172) reports this exact key/knob count and VID:PID working with the utility.
- **Inference pending physical test:** this unit uses the `k884x` configuration protocol. VID:PID alone does not prove every firmware feature, physical order, or knob direction.

## Configuration transport

Select **this device's vendor collection**, preferably usage page `0xFF00`, usage `1`, interface `0`. Never select by vendor page alone. A separate Electron implementation explicitly pads output to **65 bytes total: report ID `03`, followed by 64 payload bytes**. Its HID transport uses `node-hid`, and a 4 ms gap between writes. These are implementation evidence, not timing measurements on the attached unit. [Transport source](https://github.com/renanborgez/sikai-macos-mini-keyboard-configurator/blob/36b257ba47bd163635a59a7b038d9a6c1d6c6414/src/main/hid.ts).

## Read-first commands

All byte strings below include report ID. Pad according to the actual descriptor (65 total bytes is expected).

| Purpose | Bytes | Response interpretation |
|---|---|---|
| Query counts | `03 FB FB FB` | Including ID: byte 2 = keys, byte 3 = knobs, byte 4 = firmware kind |
| Read layer | `03 FA 0F 03 LL` | `LL=1..3`; collect up to 24 configuration records |

For read records including report ID: command `FA` at byte 1; key ID at byte 2; layer at 3; type at 4; count at 10; keyboard modifier/key pairs begin at 11–12. Preserve complete raw reports before parsing. Validate report ID, length, ID range, layer, duplicate IDs, and completeness; do not call a partial timeout a complete backup. Do not infer original delay from zeroes at bytes 5–6: stronger hardware evidence says delay is not returned.

The initial readback source was exercised on a different `514C:8850` three-key unit, **not this device**. It reports opposite knob rotation labels from upstream. Its write path was explicitly hardware-untested and uses `FD` where upstream uses `FE`; do not use it as write authority. [WebHID source](https://github.com/whatabeautifulmemory/webhid-minikeyboard-setup/blob/dfdd1ce27ea26fdc8ae73fd9c3589a160b148180/index.html), [stated limits](https://github.com/whatabeautifulmemory/webhid-minikeyboard-setup/blob/dfdd1ce27ea26fdc8ae73fd9c3589a160b148180/README.en.md).

## Restoration and protocol variants

Stronger corroboration comes from an implementation tested on `1189:8842`: retain each raw `FA` response, replace only its command byte with `FE`, and send the usual three-message finalize sequence. Keep every other byte, including unknown fields. Its source does this for all untouched bindings. Read records can arrive out of order, particularly layer 3. Mouse wheel reads may use action `04` although newly encoded writes use `03`; retaining raw bytes avoids lossy translation. **`FA` does not expose original inter-step delays or LED state.** Therefore this is a mapping backup, not a full firmware/settings image. Avoid type-5 delay and LED writes during bridge provisioning. [Round-trip implementation](https://github.com/jvspier/macropad-rebind/blob/a13af1b444161b1859f46673a4bd536817de4106/index.html), [hardware protocol observations](https://github.com/jvspier/macropad-rebind/blob/a13af1b444161b1859f46673a4bd536817de4106/docs/PROTOCOL.md).

The identify response's firmware-kind byte matters. WonKey branches at `kind >= 10`: those devices use a different `FD` packet format with three-byte keyboard entries and a shorter header. The `FE` implementation here should reject that kind rather than guess. WonKey's parser expects 65-byte `03 FA` reports; its standard read request is exactly `03 FA 0F 03 01`, collecting 24 records. [Probe and decoders](https://github.com/wimpysworld/WonKey/blob/00c552f3e8cbaa8e2601e88023d0589d00e9a707/internal/ch57/probe_linux.go), [separate encoders](https://github.com/wimpysworld/WonKey/blob/00c552f3e8cbaa8e2601e88023d0589d00e9a707/internal/ch57/encode.go).

## Write packet reference

The upstream implementation supports 15 keys plus three knobs and provides byte-level tests:

```text
03 FE KK LL TT 00 00 00 00 00 NN ...
KK = key ID; LL = layer 1..3; TT = 1 keyboard, 2 media, 3 mouse
Keyboard: NN = count (max 18), then [modifier, HID key] pairs
Media:    NN = 0, then [usage low, usage high]
Delay:    03 FE KK LL 05 delayLow delayHigh   (0..6000 ms)
Finalize: 03 AA AA ; 03 FD FE FF ; 03 AA AA
```

| Physical function | IDs |
|---|---|
| Buttons | 1–15 |
| Knob 1 | 16 / 17 / 18 |
| Knob 2 | 19 / 20 / 21 |
| Knob 3 | 22 / 23 / 24 |

Upstream labels each knob group **CCW / press / CW**. Physical direction must be tested. LED programming is separate (`KK=B0`, `TT=08`, byte 12 = color/mode); exclude it from a key-only write/restore.

Source: [k884x implementation and vectors](https://github.com/kriomant/ch57x-keyboard-tool/blob/bdbffca368f2084fbd111bc64463b881cd7c8fee/src/keyboard/k884x.rs), [shared message and knob definitions](https://github.com/kriomant/ch57x-keyboard-tool/blob/bdbffca368f2084fbd111bc64463b881cd7c8fee/src/keyboard/mod.rs). The historical Rust framing is 64 bytes including ID; the Windows HID descriptor must determine actual transfer length.

## Recommended host bridge

Use an application-owned trigger mapping for the 24 controls, retaining three complete original layers first. One candidate is F13–F24 for IDs 1–12, Ctrl+F13–F24 for IDs 13–24. HID keyboard usages are `0x68..0x73`; Ctrl modifier is `0x01`. This is a **design choice**, not a factory mapping. These keys are uncommon, not guaranteed collision-free. [USB-IF keyboard usage table](https://www.usb.org/sites/default/files/hut1_3_0.pdf).

Windows Raw Input can distinguish the source device and receive events in the background with `RIDEV_INPUTSINK`. Match the known VID/PID plus serial/device identity and only execute actions from this pad. Raw Input observation does not by itself promise system-wide suppression; reserved triggers or a clearly separate hotkey interception mechanism are still needed. [Microsoft Raw Input overview](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input), [registration flags](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice).

Recommended progression: enumerate → query counts/kind → read three layers → save raw mapping backup → verify all 72 records → implement packet tests → write one reversible control → read back and compare → physically test → restore and compare → provision remaining controls. Keep a monitor/calibration mode for physical layout and direction. Do not send `FC FC` layout-change or `EF EF` firmware-update commands; neither is necessary for mapping.

## Remaining unknowns

1. Whether this unit answers count/read commands; actual descriptor report sizes.
2. Whether raw-record `FA`→`FE` restoration behaves correctly on this unit, and whether existing hidden delays survive ordinary record replacement.
3. Physical key ordering, knob ordering/direction, and layer switch behavior.
4. F13–F24 output behavior and modifiers on this firmware; actual event delivery under rapid rotation.
5. LEDs, firmware identity, full firmware contents, and bootloader protocol are outside the evidence collected here.

## A73T physical layout follow-up

The user supplied the name **A73T** and [AliExpress item 1005012115492190](https://ko.aliexpress.com/item/1005012115492190.html). Both Korean and global versions of that exact item URL failed to open during research; no exact-model manual was found. Search results use A73T on unrelated products, so that name is not a reliable firmware identifier. The photograph supplied by the user is the authority for this unit's shape: 5 columns × 3 rows, two small knobs at the top of the right-hand control area, and a large knob beneath them.

Primary SikaiCase material shows a visually matching 15-key/3-knob variant. Its product photograph explicitly labels a **physical layer button on the edge of the case**. Its vendor-software screenshot numbers keys left-to-right, top-to-bottom: `1 2 3 4 5 / 6 7 8 9 10 / 11 12 13 14 15`. These are supporting evidence for the family, not proof that every A73T control uses the same internal slot. Sources: [manufacturer product page](https://sikaicase.com/products/15-key-3-knob-wireless-programmable-mini-keyboard), [manufacturer layer-button photograph](https://sikaicase.com/cdn/shop/files/sikaicase-15-key-3-knob-wireless-4.jpg?v=1786626572&width=1946), [vendor-software layout screenshot](https://cdn.shopifycdn.net/s/files/1/0655/8570/9299/files/4949af4db92be296911829e24e657377_efceaa02-42ac-4a88-8d2b-595f0fa0bff6_1024x1024.png?v=1689127506), linked from the [official setup guide](https://sikaicase.com/blogs/support/setting-for-software).

User interaction for calibration should be explicit without inventing a button position: **케이스 옆면의 작은 레이어 전환 버튼을 짧게 한 번씩 누르세요. 표시등이 바뀌면 같은 일반 키를 한 번 눌러 현재 레이어의 입력을 확인합니다. 다시 한 번 눌러 다음 레이어에서도 반복합니다.** The software's layer tabs select which stored mapping is edited; they are not evidence of the active physical layer. There is no verified host-side layer-switch command for this unit. Do not tell the user to long-press a knob, move the wireless power switch, or use an invented key combination.

Knob order still needs physical calibration. Another configurator explicitly calls **large knob = knob 1** an assumption and asks users to report differences; it is not sufficient to override observed hardware. Test each physical knob in this order: small top-left CCW/press/CW, small top-right CCW/press/CW, large bottom CCW/press/CW. Record the received slot IDs and swap direction labels where needed. [Configurator's stated assumption](https://github.com/renanborgez/sikai-macos-mini-keyboard-configurator/blob/36b257ba47bd163635a59a7b038d9a6c1d6c6414/README.md#key--knob-ids).

### Local capture now confirms the read protocol

The parent-created `.local/evidence/device-readback.json` was inspected read-only. At its recorded `2026-11-16T05:22:46.535Z` observation, identity reply began `03 FB 0F 03 00`: 15 keys, 3 knobs, firmware kind 0. Each of layers 1, 2, and 3 returned exactly 24 **65-byte** `03 FA` records, with slot IDs 1–24 and matching layer bytes. Thus count/read support and standard packet shape are now **observed on this unit**, not merely inferred from other models. This capture alone does not establish physical order, active-layer selection, knob direction, write persistence, or hidden-delay restoration.
