# PC pages — MONO DECK 2.2

## v2.5 — instant page zero, portable editing

Page selection is now independent of physical memory mode. Ctrl+Alt+0 selects the PC-executed copy of the corresponding device group's portable preset; 1–9 select ordinary PC pages and the common knob includes zero and every later page. No navigation path calls the device writer. Zero selection is allowed before physical input, without inventing a current hardware group. The actual incoming device group selects the zero bank to execute. Physical group detection remains input-based; the verified protocol cannot query or switch its active side-button state.

Zero's dedicated editor exposes only none, keyboard shortcut, media, and at most 18 keyboard chords. The backend uses the same portable compiler for every save, so app launch, text, mouse coordinates, delays, repeats, conditions, and 19+ chords cannot enter through alternate IPC requests. Unknown original records remain preserved/read-only and are not executed by the PC mirror. Firmware timing cannot be read or faithfully replayed. The common navigation knob is reserved and bypasses page-specific overrides.

`saveZeroPreset` changes only the per-device PC bank. `applyZeroPreset` uses a reviewed bank hash and explicitly writes that bank to the named hardware group. The PC-to-zero copy dialog also separates saving to the PC bank from recording to the device. The explicit device writer retains backup, durable journal, changed-slot commits and all-72 readback verification. A preset edit or navigation cannot trigger it. Hardware that still sends direct inputs must first use the explicit PC connection preparation before the PC can run different page actions.

At initial capture direct mappings are preserved and app-only signals become empty portable slots. Existing bank files survive PC-trigger mode and restart. Explicit device-to-zero import merges direct slots and preserves bank contents where the hardware currently contains app triggers; an all-trigger map cannot erase a preset. Per-device banks remain outside PC profile exports. Physical uploads change what the keyboard sends without MONO DECK; page zero selection alone does not. App shutdown does not rewrite the device.

All earlier zero-to-hardware-write navigation descriptions below are historical and superseded by v2.5.

## v2.4 — onboard page zero and device groups

The physical layers 1/2/3 are called **device groups** in the runtime banner. Each group has one stored onboard bank (page **0**) and the existing PC-page binding sets. Ctrl+Alt+0 applies the last physically confirmed group's onboard bank. Ctrl+Alt+1–9 selects PC pages 1–9; page 10 and later remain in the common knob/browser sequence. The upper-right navigation knob always previews previous/next, including zero, and confirms on press. PC-page overrides cannot disable that navigation knob. The common knob is retained as canonical app input even in onboard zero and therefore needs MONO DECK to navigate.

PC-to-PC selection performs no hardware write. Crossing the onboard/PC boundary freezes the destination group, stops running macros, backs up readable mappings, writes changed slots, verifies all 72 records and only then publishes the completed mode. The UI shows actual reading/writing/verifying progress and blocks overlapping actions. Unknown, mixed or failed modes do not dispatch PC macros. A normal quit waits for a pending transaction; it does not automatically rewrite hardware. The last applied hardware configuration remains after exit. Switch to zero before disconnecting when portable direct-key behavior is wanted.

Group identity is inferred only from device-scoped canonical inputs, with a last-confirmed timestamp. Editor group tabs, action hotkeys and guesses do not establish physical state. It starts unknown and is invalidated on unplug/input-bridge loss. Zero hotkeys require a confirmed group; PC page selection without one selects the page but performs no hardware write. Physical side-button switching alone is not observable in the verified protocol. Turn the navigation knob once after changing a physical group.

Per-device onboard banks live under `%APPDATA%/mono-deck/onboard-banks/`, outside PC profile exports. First capture preserves direct raw mappings, converts app-only triggers to empty portable slots, and reserves navigation. Every bank file has a checksum and a device serial binding. A durable pending transaction records its backup and intended mapping before the first write. Startup resolves a completed journal only by exact readback; it never replays an interrupted write automatically. An explicit mode selection can recover a partial state. Corrupt banks fail closed and are preserved for inspection.

**온보드 0 저장 / 읽기** now merges selected compatible PC actions into the group's saved zero bank and applies the full group in onboard mode; omitted actions retain the previous zero-bank settings. It also offers **보관된 온보드 0 읽기**, separate from current physical mapping readback. A bank can be read while the device is currently in PC mode. The three navigation controls cannot be overwritten by a portable upload. PC bindings remain unchanged.

The sections below document earlier revisions; the v2.4 zero shortcut and fixed navigation rules supersede their former Ctrl+Alt+0-to-page-10 and navigation-override behavior.

Implemented and verified on 2026-11-17 (Asia/Seoul).

PC pages are the existing profiles, renamed in the interface. Each page retains its three physical-device-layer binding maps. Selecting a PC page never writes HID mappings or changes the physical layer. The 1/2/3 editor selector still chooses which physical layer's PC bindings to edit; use the device side button to change its physical layer.

## Navigation

- `page` actions: `previous`, `next`, `select` (stable `profileId`), `previewPrevious`, `previewNext`, `confirm`, `cancel`.
- Previous/next wrap around the ordered page list. Direct selection uses IDs, so renaming a page does not break the action.
- Ctrl+Alt+1 through 9 select the first nine pages; Ctrl+Alt+0 selects the tenth. These registrations are independent of page bindings. Missing pages produce a log entry. Registration failures are logged and displayed in the page banner. The shortcut group can be disabled in Settings.
- The upper-right knob (default knob 2; initial migration respects calibrated knob order) inherits previous/next candidate selection and press-to-confirm from common bindings. Browsing never changes the active page until confirmed. Eight seconds without input cancels the candidate. Candidate expiry and wrapping are tested.
- Navigation is available while the editor is focused or macro execution is paused. Recording blocks navigation. Actual page changes cancel an active macro; candidate browsing alone does not. Automatic application switching is deferred while a candidate is pending.
- A non-focusing, click-through HUD on the pointer's display shows a candidate or the committed page. The editor persistently displays current page name/number, separately from the physical layer.

## Common defaults and overrides

`config.commonBindings` supplies a base binding for each control across every PC page and physical layer. A page's explicit binding wins, including `none` (deliberately disables the common action). The inspector's save scope chooses either this page/device layer or all pages' common defaults. Removing a page override with the common-key button restores inheritance. Editing the upper-right knob is supported just like any other control.

The v2-to-v3 startup migration makes a timestamped `profiles.json.before-v3-*` backup, keeps existing pages and other bindings, removes only the upper-right knob's page overrides, and installs its common navigation defaults. The original knob bindings remain in that backup. Subsequent startups preserve user overrides. Schema version remains 1 with `schemaRevision:3`. Export/import carries common bindings and page shortcut preferences. Importing older configurations preserves their explicit bindings, which can override the new common defaults.

## Validation

- `npm test`: 100 tests passed. New tests exercise wraparound, single-page operation, invalid/deleted targets, preview/commit/cancel/expiry, common inheritance and explicit disabling, focused-editor dispatch, and the full ten global shortcuts across page changes.
- `npm run package`: TypeScript, Vite and packaged Windows app succeeded, version 2.2.0.
- Live packaged UI: Ctrl+Alt+2 selected Creative, preview testing showed candidate 111 while Creative remained active, separate HUD displayed candidate and confirmation guidance, and Ctrl+Alt+6 restored the original page 666. Preview expiration was observed. The physical knob itself has not yet been turned/pressed for this version.
- Migration readback: seven user pages preserved in the same order, all bindings outside the designated navigation knob matched the pre-migration backup. Evidence: `.local/evidence/pages-v2.2-verification.json`.
- No device writes were performed for this feature. Device startup readback reported 72 app-connected controls.


## User confirmation and v2.2.1 follow-up

On 2026-11-17 the user confirmed physical page navigation works. The reported clockwise-only indicator was caused by a shared `.dial.pressed { transform: rotate(7deg) }` for both turns and press. Version 2.2.1 replaces this with signed, unwrapped visual rotation (18 illustrative degrees per input detent), an independently rotating rim/marker, a stationary icon, directional edge highlights, and press-only travel. A separate activity timer per knob prevents one knob clearing another. Reduced-motion preferences remove transitions. This depicts relative events, not a measured absolute shaft angle.

The onboard dialog now separates the PC source configuration from destination device layer 1/2/3. Choose a PC page and the source physical-layer binding set containing the desired actions, open Keyboard Save/Read, and choose the device destination independently. Whole-configuration mode offers explicit slot checkboxes. Page navigation and advanced PC actions remain incompatible unless excluded; nothing is silently skipped. Excluded slots retain their existing device mappings. Target or selection changes invalidate the reviewed upload plan. Imported device records are explicitly remapped into the original PC editing layer.

Validation: 104 tests passed; production build/package 2.2.1 passed. Live UI verified source L1 remaining intact while destination switched to L3, selecting the whole configuration, deselecting a slot (3 to 2 selected), and closing with Esc. No HID writes were performed. New animation direction/state calculations were tested, but a live physical turn with this revised animation has not yet been independently observed.

## PC 페이지 삭제 (v2.6.4)

왼쪽 목록에서 지울 PC 페이지를 선택한 다음, 키보드 그림 위 오른쪽의 **페이지 삭제**를 누릅니다. 확인창에서 페이지 이름과 범위를 확인하고 **이 페이지 삭제**를 누르면 적용됩니다. 이름 옆 화살표의 편집창에서도 같은 확인창을 열 수 있습니다. Esc 또는 취소는 설정을 변경하지 않습니다.

선택한 PC 페이지의 그룹 1·2·3 구성을 함께 삭제하며, 뒤 페이지 번호와 Ctrl+Alt+숫자 배정은 앞당겨집니다. 활성 페이지를 삭제하면 바로 앞 페이지로 이동합니다. 첫 페이지를 삭제한 경우에는 다음 페이지로 이동합니다. 0번 기기 프리셋, 키보드 메모리, 공통 노브와 나머지 페이지 설정은 유지됩니다. PC 페이지는 최소 하나가 필요합니다.

삭제 전 전체 설정을 데이터 폴더의 `page-backups/before-delete-*.json`에 자동 보관합니다. **설정 → 로컬 데이터 폴더**에서 확인할 수 있습니다. 삭제한 페이지만 복구하려면 **프리셋 라이브러리 → 파일 불러오기**에서 해당 백업을 열고 필요한 페이지만 선택합니다. 페이지 이동 액션이 들어 있는 경우 연결 대상도 함께 선택해야 합니다. 전체 상태를 복원하려면 **설정 → 전체 설정 백업 복원**을 사용합니다.

다른 페이지나 공통 키에서 삭제 대상 페이지로 이동하는 액션이 있으면, 삭제창에 페이지·그룹·키 위치와 매크로 단계가 표시됩니다. **연결 해제하고 삭제**를 누르면 해당 이동 동작만 비워두기로 바뀝니다. 같은 매크로의 다른 단계, 반복 설정과 다른 키는 유지됩니다. 비워두기로 바꾼 키는 공통 키로 자동 대체되지 않습니다. 연결 해제 전 상태도 전체 백업에 포함되므로 연결까지 되돌리려면 전체 설정 백업 복원을 사용하세요. 확인 중 대상이나 연결 설정이 달라지면 갱신된 내용을 다시 확인하도록 합니다. 실행 중인 매크로는 삭제 시 중지하며, 노브의 미확정 페이지 후보도 취소합니다.
