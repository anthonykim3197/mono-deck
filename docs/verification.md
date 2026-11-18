# Verification status

Public verification summary for MONO DECK v2.6.4, prepared 2026-11-18. Raw device captures, device instance identifiers, local application settings, user-created profiles and private analysis artifacts are intentionally excluded from this repository.

## Automated checks

`npm test` passed **152 tests** on Windows x64. Production TypeScript checking, Vite build, native C# compilation and Electron Windows directory packaging passed for v2.6.4.

Coverage includes:

- HID report framing, complete 72-slot reads, opaque report preservation, write/readback verification, mapping backups and rollback paths.
- Configuration validation, key-chord encoding, onboard compatibility limits and zero/PC mode transitions.
- Macro ordering, cancellation, held-input release, delay, repetition, conditional branches, focus guards and monitor-coordinate conversion.
- Native helper startup/shutdown, JSONL request IDs, invalid-input rejection, device-specific modifier tracking and emergency-stop state.
- Page navigation, common controls, stale candidates, additive preset import/export and OBS protocol/controller behavior.
- Page deletion with incoming navigation links: reviewed cleanup of matching actions, preserved sibling macro steps, explicit empty slots, stale-review detection and readable IPC errors.

Most hardware and OBS tests use simulated transports. Passing these tests does not establish compatibility with every firmware, external application or display arrangement.

## Observed on a physical A73T

One 15-key/3-knob unit with USB VID:PID `1189:8840` was tested.

- Read and backed up 72 distinct mappings, 24 per physical group.
- Provisioned all three groups with unique application trigger signals and verified readback. Writes to a selected group preserved the other groups.
- Confirmed the upper-left key in each physical group reaches the correct logical key and group in the application. This was representative testing, not an exhaustive physical press of every control.
- Confirmed knob input and cyan press-reactive lighting. Lighting application preserved key mappings.
- Tested onboard shortcut → PC trigger → onboard shortcut switching with physical key presses and restored the original mapping.
- Probed keyboard-sequence capacity: 18 modifier/key pairs were supported by the tested firmware. This limit applies to onboard key sequences, not the PC macro engine.
- Physical group-button changes alone did not provide an observable group update. The UI therefore displays the last group confirmed by a key or knob event, not a live switch query.

## Observed in the packaged Windows app

- The 15-key / 3-knob control surface, Korean labels, input monitor, preset library and onboard editor rendered in the packaged application.
- Native Unicode text output reached the app-owned diagnostic text field.
- A mixed macro moved the pointer, clicked, waited 500 ms, sent Ctrl+A, typed Unicode text and balanced an F8 key press/release in the visible app-owned test pad. This was not a test of arbitrary third-party application automation.
- Preset import appended pages while preserving existing settings; export and duplicate detection were checked.
- The common navigation knob and Ctrl+Alt+0–9 page routing were checked. Onboard zero and PC page selection are immediate host-side changes; explicit hardware writes remain separate.
- The v2.6.4 deletion dialog displayed a real incoming page link and the detach-and-delete choice. Deletion of a copy of that configuration cleared only the matching navigation action. The live settings were preserved during verification.

## Remaining limits

- OBS scene/audio operations have protocol/controller tests; live multi-source HDMI/USB mixer audio was not tested. Configure and verify the sources on the intended OBS computer.
- Preset shortcuts depend on application version, keyboard layout, focus and user customization. The GPT preset was checked against the installed Windows app's shortcut definitions; end-to-end operation of every target-app shortcut was not exercised.
- Multi-monitor coordinate conversion has automated coverage; all real DPI and monitor arrangements have not been tested.
- RGB pattern names are conservative. Exact pattern appearance and persistence after power cycling have not been verified for all modes.
- The firmware's complete image, existing macro timing and current RGB settings are not captured by mapping backups.
- No confirmed command reads or changes the active physical group directly. Use the device's physical selector and a subsequent key/knob event.

See [protocol research](protocol-research.md), [onboard storage](onboard-storage.md), [vendor analysis](vendor-analysis.md) and [RGB research](rgb-layer-research.md) for technical context. Local evidence paths or analysis IDs mentioned in historical research notes identify development observations, not files shipped in the public repository.
