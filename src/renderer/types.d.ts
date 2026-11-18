export interface Action {
  obsOperation?:string;inputRole?:'volume'|'microphone'|'selected';sceneIndex?:number;audioIndex?:number;volumeStepDb?:number;
  pageOperation?: 'next'|'previous'|'select'|'previewNext'|'previewPrevious'|'confirm'|'cancel';
  type: string; label: string; icon?: string; color?: string;
  keys?: string[]; text?: string; url?: string; path?: string; args?: string[];
  media?: string; steps?: Action[]; profileId?: string; delayMs?: number;
  disabled?: boolean; comment?: string; jitterMs?: number;
  key?: string; state?: 'down' | 'up';
  mouseAction?: 'move' | 'click' | 'down' | 'up' | 'scroll';
  x?: number; y?: number; relative?: boolean; button?: 'left' | 'right' | 'middle'; clicks?: number; delta?: number;
  count?: number; repeatCount?: number; repeatMode?: 'count' | 'toggle';
  condition?: 'pixel' | 'window'; tolerance?: number; process?: string; titleContains?: string;
  thenSteps?: Action[]; elseSteps?: Action[]; timeoutMs?: number; pollMs?: number;
  pixelColor?: string; hotkey?: string; playbackSpeed?: number; intervalMs?: number;
  coordinateSpace?: 'desktop'|'monitor'; monitorId?: string;
}
export interface Profile { id: string; name: string; presetId?:string;description?:string;matchProcess?: string; bindings: Record<string, Action>; layers?: Record<string, Record<string, Action>> }
export interface PresetPreview {token:string;name:string;description:string;profiles:{id:string;name:string;description:string;alreadyInstalled:boolean;keys:{control:string;label:string;type:string;detail:string}[];knobs:{position:string;actions:string[]}[];warnings:string[]}[]}
export interface ProfileDeletionReview {id:string;name:string;hash:string;references:{profileId:string|null;profileName:string;group:number|null;control:string;path:{field:string;index:number}[]}[]}
export interface ObsTargets {volume?:string;microphone?:string;sources?:string[]}
export interface ObsInventory {connected:boolean;currentScene:string;scenes:{sceneName:string;sceneIndex:number}[];audio:{inputName:string;inputKind:string;inputVolumeDb:number}[];targets:ObsTargets;selectedAudio?:string}
export interface ModeTransition {layer:number;targetMode:'pc'|'onboard';phase:string;done:number;total:number;startedAt:string}
export interface PageState {activeId:string;candidateId:string|null;layer:number|null;pages:{id:string;name:string}[];hotkeyFailures?:string[];mode?:'pc'|'onboard'|'mixed'|'unknown';hardwareMode?:string;lastConfirmedAt?:string|null;groupConfirmed?:boolean;groups?:Record<string,{mode:string;storedCount:number;savedAt:string}>;transition?:ModeTransition|null;error?:string|null}
export interface Config { commonBindings?:Record<string,Action>;pageHotkeys?:boolean;pageMode?:'pc'|'onboard'; version: 1; activeProfile: string; enabled: boolean; startAtLogin: boolean; selectedLayer?: number; knobDirection?: Record<string, boolean>; knobOrder?: number[]; profiles: Profile[] }
export interface DeviceStatus {
  connected: boolean; vid: string; pid: string; product?: string; serial?: string;
  path?: string; firmware?: string; provisioned?: boolean; bridgeReady?: boolean; error?: string; layer?: number; activeLayer?: number;activeLayerAt?:string;
  layers?: Record<string, {provisioned?: boolean; mappedControls?: number} | boolean>;
}
export interface LogEvent { page?:PageState; type: string; time: string; message?: string; control?: string; level?: string; device?: DeviceStatus; config?: Config; layer?: number; status?: string; step?: number; total?: number; recording?: boolean; starting?: boolean; count?: number; running?: boolean; steps?: Action[] }
export interface LightingCapabilities {supported: boolean; modes: {id: string; name: string}[]; colors?: {id: string; name: string}[]; note: string; factoryOnly?:boolean}
export interface MonitorInfo {id:string;device:string;left:number;top:number;width:number;height:number;primary:boolean;dpiX?:number;dpiY?:number}
export interface OnboardSlot {layer:number;control:string}
export interface OnboardEntry extends OnboardSlot {action:Action}
export interface OnboardRow extends OnboardSlot {kind:string;summary:string;action?:Action;raw65?:number[];appManaged?:boolean;editable?:boolean;timingKnown?:boolean}
export interface OnboardPlan {ok:boolean;entries:(OnboardEntry&{kind?:string;summary?:string})[];incompatible:(OnboardSlot&{reason:string})[];warnings:string[];hash:string}
export interface DeckAPI {
  previewPreset(source:'builtin'|'file'|'obsMixer'):Promise<PresetPreview|null>;
  addPreset(token:string,ids:string[]):Promise<{config:Config;added:{id:string;name:string}[];skipped:number}>;
  exportPreset(ids:string[]):Promise<{ok:boolean}>;
  inspectObs():Promise<ObsInventory>;
  saveObsTargets(targets:ObsTargets):Promise<ObsTargets>;
  getState(): Promise<{config: Config; device: DeviceStatus; events: LogEvent[];page?:PageState}>;
  navigatePage(operation:string,id?:string):Promise<PageState>;
  readOnboardBank?(layer:number):Promise<{entries:OnboardRow[];storedCount?:number;hash:string}>;
  saveZeroPreset?(entries:OnboardEntry[],options:{expectedHash:string}):Promise<{ok:boolean;message:string}>;
  applyZeroPreset?(layer:number,hash:string):Promise<{ok:boolean;message:string}>;
  importZeroPreset?(layer:number):Promise<{ok:boolean;message:string}>;
  saveConfig(config: Config): Promise<Config>;
  previewProfileDeletion(id:string):Promise<ProfileDeletionReview>;
  deleteProfile(id:string,hash:string):Promise<{config:Config;backupPath:string;detachedCount:number}>;
  onEvent(callback: (event: LogEvent) => void): () => void;
  refreshDevice(): Promise<DeviceStatus>;
  backupDevice(): Promise<{path: string}>;
  provisionDevice(layers?: number[]): Promise<{ok: boolean; path?: string; message?: string}>;
  restoreDevice(layers?: number[]): Promise<{ok: boolean; message?: string}>;
  getLightingCapabilities?(): Promise<LightingCapabilities>;
  setLighting?(settings: {layer: number; mode: string; color?: string}): Promise<{ok: boolean; message?: string}>;
  runMacro?(action: Action, options: {dryRun: boolean}): Promise<{ok: boolean; error?: string; message?: string; plan?: unknown; cancelled?: boolean}>;
  stopMacro?(): Promise<{ok: boolean}>;
  startRecording?(options?:{mouseMove?:boolean}): Promise<{ok: boolean; error?: string}>;
  stopRecording?(): Promise<Action[] | {steps: Action[]}>;
  getCursor?(delayMs?:number): Promise<{x:number;y:number;monitorId?:string;localX?:number;localY?:number}>;
  getPixel?(x: number, y: number, monitorId?:string): Promise<{color: string | number; x?: number; y?: number}>;
  getMonitors?():Promise<{monitors:MonitorInfo[];virtualDesktop:{left:number;top:number;width:number;height:number}}>;
  testAction(action: Action): Promise<{ok: boolean; error?: string}>;
  exportConfig(): Promise<{ok: boolean}>;
  importConfig(): Promise<Config | null>;
  setLogin(enabled: boolean): Promise<boolean>;
  openDataFolder(): Promise<void>;
  openTestPad?(): Promise<{ok?:boolean;message?:string}|void>;
  planOnboard?(entries:OnboardEntry[]):Promise<OnboardPlan>;
  readOnboard?():Promise<{ok?:boolean;entries:OnboardRow[];readAt?:string;timingKnown?:boolean;lightingKnown?:boolean}>;
  uploadOnboard?(entries:OnboardEntry[],options:{expectedHash:string}):Promise<{ok:boolean;message?:string}>;
  restoreAppSlots?(slots:OnboardSlot[]):Promise<{ok:boolean;message?:string}>;
}
declare global { interface Window { deck?: DeckAPI } }
