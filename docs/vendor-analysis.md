# Vendor executable static analysis

Analyzed 2026-11-16. Neither executable was launched. No vendor code was loaded into the analysis process as an assembly, and this investigation sent no USB commands. Native analysis used REA with Ghidra 12.1.4; managed analysis used REA's file-backed PE/CLI and CIL readers.

## Practical findings

- The native vendor's 15-key form matches the A73T photo: **K1 is the upper-left small knob, K2 the upper-right small knob, K3 the lower large knob**. This is a static UI correspondence, not a physical event test.
- The vendor maps K1 left/press/right to IDs **16/17/18**, K2 to **19/20/21**, and K3 to **22/23/24**. Ordinary buttons are IDs **1–15**, displayed in row-major order, five columns by three rows.
- “Left / middle / right” are the actual vendor object names. Counterclockwise / press / clockwise is the intended interpretation; physical rotation direction still needs a one-step calibration against the attached unit.
- The native layer selector updates the host's selected editing layer. We found **no established current hardware layer query** in the inspected paths. The app must distinguish its software profile, the stored layer being edited, and the physical device's active layer.
- The supplied native program uses a **long-header FD keyboard staging path** and **FE B0 RGB staging**. Do not replace the project's empirically verified FE keyboard protocol with FD based on this artifact alone.
- It batches staged records and sends a single FD FE FF commit after each edited layer. This proves batching in this vendor program's mixed staging path, **not a direct validation of FE keyboard batching on this connected firmware**.
- Keep the project's tested FE mapping, backups, exact readback, and layer-1/2 preservation. No RGB or device-type writes were added from static evidence.

## Artifact identities

| Artifact | Bytes | Classification | SHA-256 |
| --- | ---: | --- | --- |
| `MINI_KEYBOARD.exe` | 2,081,280 | Native x86 PE32; Qt5 and HIDAPI imports; no CLI directory | `3b77babb3acb6fd73cdeddbd5aed724e28f12068db910e05c30a131966260b44` |
| `MINI KeyBoard.exe` | 217,088 | Managed x86 PE/CLI; IL-only, 32-bit required; .NET Framework 4.0; WinForms | `4ae53d3a40921e4f57444c489fa1b38fe91a2e907feda17630450fc97a7cd7b1` |

The managed assembly reports name `MINI KeyBoard`, version `1.0.0.0`, metadata `v4.0.30319`, and MVID `830e3432-592a-4fe8-a60e-4e46348e689c`. These are distinct builds and implementations, not interchangeable original source trees.

Artifact paths are relative to this repository root. The authoritative bytes are the user-provided files. No authenticity claim about their publisher or download origin is made.

## Native physical layout evidence

Ghidra's UI constructor at `0x44c790` defines:

| UI control | Object pointer offset | Layout |
| --- | --- | --- |
| K1 left / middle / right | `this+0x28 / +0x30 / +0x38` | First three buttons in upper horizontal layout |
| K2 left / middle / right | `this+0x40 / +0x48 / +0x50` | Next three buttons in the same upper layout |
| K3 left / middle / right | `this+0x14 / +0x18 / +0x1c` | Grid row 3, columns 1 / 2 / 3 |
| Upper knob layout | `this+0x24` | Grid row 1, spanning columns 0–4 |
| Ordinary keys | 15 controls | Grid rows 0–2, columns 0–4; K1–K5 top row |

The knob region is placed beside the ordinary key region. This is the same relative arrangement as the supplied photo: two small knobs above one larger knob.

The handler at `0x403eb0` compares the clicked object name and assigns the selected record ID. Explicit cases are:

```
pushButton_K1 … pushButton_K15 -> 1 … 15
k1_left / k1_middle / k1_right -> 16 / 17 / 18
k2_left / k2_middle / k2_right -> 19 / 20 / 21
k3_left / k3_middle / k3_right -> 22 / 23 / 24
```

Evidence:
- UI constructor: `ev_0217b9ab3e2abe543c85ec9d8e44fa1c870f3e02da5d2666dbdeb0cd5fbc977f`
- Handler and IDs: `ev_6de8fb5127bfee27c790a575bb51c13b92d115ceebaa9f1d74e1b2a79a430da9`
- Defined string names and addresses: `ev_6b7d6a05c00aeff2c1936d7c59eea49e704cc51216dab8364013de6f0a566cb8`

## Native protocol observations

Offsets below include report ID unless otherwise stated.

### Transport and staging

All six direct call sites of the HIDAPI `hid_write` thunk were inspected. Calls use 65-byte writes (`0x41`) with report ID 3. The thunk is `0x44a878`; its direct references are `0x40995b`, `0x40a9d5`, `0x40aa71`, `0x40ed32`, `0x442d55`, and `0x442fdc`.

The host stores 3 × 60 × 50 bytes starting at `0x5f7140`, plus 3 × 60 modified flags at `0x5f7080`. This is host capacity, not evidence the attached device has 60 controls. Initialization at `0x4098b0` sets command FD in each 50-byte record. Key selection at `0x403eb0` / `0x40f7a0` likewise sets FD, then ID and layer+1. Keyboard construction at `0x40c9a0` increments count at record offset 9 and writes key usages at offset 11 + 2×entry. The host-record offsets exclude report ID, so these correspond to report count offset 10 and key-usage offset 12.

The native long-header FD builder is a **different observation** from upstream short-header FD firmware-kind support. Equal command bytes do not establish equal layouts. Our connected device's validated FE behavior remains the implementation authority.

### Batch write and commit

Function `0x40a860`:
1. Iterates all three layer regions and 60 reserved entries per layer.
2. For each modified flag, copies its 50-byte record into report offsets 1–50 and writes 65 bytes.
3. At the final slot of each layer, if any record was sent, writes `03 FD FE FF` with zero padding, then sleeps 200 ms.
4. Clears modified flags.

The assembly independently confirms the loop limits, 50-byte copy, 65-byte write, report ID, commit constants, and delay. No AA AA packet occurs in this function. Do not infer that the project's already validated per-binding finalize sequence should be removed.

Evidence:
- Full write-function dossier, including assembly: `ev_763e7c41b282cf0335a49080b9189ba7764b31755f542b5f04304f82910ae772`
- FD initialization: `ev_d1bf66da367afd396fd4c5bf0e74dcc3eb1ae396220de4a86dedc31dea28af04`
- FD key selection: `ev_a11875967650a89ab778847c285519be68f9368a3bcd98b9c6b5be1c19c9e243`
- Keyboard record builder: `ev_977a8080e13ab48b1ca2b4b20b3754fd696cf9dfaa2014f25ac12f5234d353a2`
- HID write xrefs: `ev_b9b874489eb3034ee6ecb3aa614a822e2b08c83b75cc788ee088ea0e2b65cb8b`

### Read and information requests

Function `0x40ec80` builds `03 FA keyCount knobCount layer`, increments the requested layer from 1, receives ordinary records, then knob records beginning at ID16. The knob range ends at 15 + 3×knobCount. It copies 49 bytes after the command into the staged host record.

The vendor asks HIDAPI to read 64 bytes (`0x40`) in this path. This is a static artifact fact, **not a reason to truncate the connected unit's observed 65-byte reports** or weaken MONO DECK's validation.

Function `0x442d00` emits `03 FB FB FB`, reads with a 10 ms timeout, and applies returned configuration to the UI. Its decompiled local variables alias ambiguously; the actual observed device info offsets in `.local/evidence/device-readback.json` and the protocol module take precedence.

Evidence:
- Read configuration: `ev_474570b9d0671d06e02a8bd01bffb2ecbfe42b1befff277355c29dd334b650b5`
- Information request: `ev_1686a6bd43e5839a29714d735376da18dd03877f017863791b0039519150fd21`

### Layer selection and unsupported commands

The UI connects layer buttons with integer IDs 0, 1, 2 to `SendLayer(int)`. The handler at `0x40f110` stores the chosen value at `0x5f9471`, changes selected button styling, clears the current key selection, and refreshes the view. Its inspected callees do not establish a USB layer-switch command. Static typed xrefs show a single direct write to this host-selected-layer global, at `0x40f123`. This does not exclude indirect accesses or uninspected paths.

A separate native function at `0x442f30` emits an FC-prefixed device configuration command with selectable key/knob counts, then refreshes configuration. This is device-shape configuration, not a proven active-layer selector; do not send it for calibration. Another function emits an EF-prefixed report; its full semantic purpose was not resolved. Neither was executed.

Evidence:
- Layer signal hookup: `ev_0e4100fb05e0bd14ba18d0be70bb0b7252b6c8492fbf1462240963db75a1128d`
- Selected-layer handler dossier: `ev_fe1639750e2636eb008e37d7ffea73a9334e40e4724eb2ad34b40eac79352035`
- Selected-layer typed references: `ev_333497b00010354f6da53c06c38678232e77e1d97ea911f28bdc04752fe50973`
- Device-shape configuration: `ev_f199fa6acf8e17c442b1dd3fd7d422e66162b9b83f1af566c2fb903b7a0de580`
- EF-prefixed path: `ev_20e1ba0cdbe0cdc012e9f5602e868c3fb61494e866763cf5bd97b28cf39f28b9`

### RGB boundary

Function `0x40cd80`, linked to the literal `SetRgb_Led_Key(int index)`, builds a staged record beginning `FE B0 layer+1`. It sets count 1, combines high/low nibbles of a value at record offset 11, and supplies high nibble 5 when the high nibble is zero. The mode field comes from another UI state variable.

This confirms an RGB-related FE B0 family but **does not validate a complete mode/color table, lighting readback, restore semantics, or compatibility with this A73T firmware**. Leave RGB outside provisioning and mapping backup guarantees.

Evidence: `ev_16578e4304623e4fa7c649785eef198bfe595894603bd6960cfb6253db1f37df`.

## Managed comparison artifact

Static metadata contains 30 types, 295 methods, 331 fields, and 388 referenced user strings. Types include `HID.Hid`, `HIDTester.HidLib`, `HIDTester.FormMain`, `LayerFun`, `LEDkey`, `MouseKey`, `BasicKeys`, and `MULKey`.

Useful method declarations in this build include:
- `FormMain.Send_WriteFlash_Cmd` token `0x06000039`
- `Send_WriteFlashLED_Cmd` token `0x0600003a`
- `Send_SwLayer` token `0x0600003b`
- `Download_Click` token `0x0600003c`
- `HidLib.WriteDevice` token `0x06000061`
- Named ordinary click handlers KEY1–KEY12 and K1/K2 left/centre/right
- Layer1/2/3 radio-button handlers and three LED mode handlers

These names and CIL body existence were observed, but the managed packet builders were **not fully reconstructed**. A method named Send_SwLayer is not proof of a current-layer query or hardware switching behavior. Its UI shape also must not override the native 15-key layout evidence.

Evidence:
- PE/CLI identity summary: `ev_9d9c9c6ae6c5bbbea4b38e44261586bba25aba49bd30123d782046832f9689b7`
- Canonical managed-members evidence: `ev_b6193f8e80ae6754d9ce63c44befcf33c143f246019fd70958b6fa5ead863fa5`
- Complete type page: `ev_ab18d95908f73893aada390de94ee5541571ed23bc694c1fd13c07a748127b59`
- Selected method page: `ev_ad61bad7f43dcbc0a7889d8fd5bbf4177295d5b422efc11f98dcb040f93ff031`

Metadata, methods, and member relationships were reported complete for the requested artifact. User-string coverage is partial: three terminal-flag mismatches at tokens `0x700008ed`, `0x700008f1`, `0x70001067`; readable string values were retained. Tokens are meaningful only with the recorded SHA-256 and MVID.

## Coverage and limitations

Native inventory: 537 analyzed procedures, 1,157 defined strings, and 10 segments including headers. Native PE resource enumeration found only icon, group-icon, and version resources; other Qt assets may reside in embedded Qt resource data. We used the compiled UI constructor directly and did not extract or run a reconstructed UI.

Ghidra pseudocode is **decompiler-generated non-source**, not recovered original C++ and not directly compilable. Several transport functions report unsettled type propagation and stack-variable aliasing. Critical batch constants were checked against assembly. Static xrefs and defined-string completeness do not establish runtime coverage or absence of indirect behavior.

The host's valid report construction does not prove the firmware accepts every command. The project's successful physical provisioning, all-layer readback, and unchanged layer-1/2 comparison are stronger evidence for supported writes on the connected unit. This investigation did not duplicate those hardware actions.

Native overview evidence: `ev_47cc50c8f45c64f010a8cf92442910ea88d05c3b470bd61c97af95c173dbe49b`.
PE resource evidence: `ev_91e4bf11955b9f81edcbe99e2ea906285bd102b287a8a2c1ecfbba47176c1c6c`.
Native classification: `ev_c42e49e30d78193c7dc32096ef090ad1970003b416bcec5410567a92725ba6f1`.

Related implementation context and primary upstream source links: [protocol-research.md](protocol-research.md). REA saved `.local/vendor-analysis/rea-static-snapshot.json` (4,717,870 bytes; 40 retained evidence records) and successfully closed the native analysis session. This provider-neutral snapshot preserves eligible retained observations; it is not a full Ghidra project or source recovery.
