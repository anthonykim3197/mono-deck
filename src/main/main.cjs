const {app,BrowserWindow,ipcMain,dialog,shell,Tray,Menu,nativeImage,globalShortcut,screen}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {Keyboard,lightingModes,lightingColors}=require('./protocol.cjs');
const {Bridge}=require('./bridge.cjs');
const {MacroRunner}=require('./macro-engine.cjs');
const {defaults,validateConfig,validateAction}=require('./config.cjs');
const {PageNavigation,resolveBindings,defaultCommonBindings,previewProfileDeletion,removeProfile,ONBOARD_ID}=require('./pages.cjs');
const {ModeManager}=require('./mode-manager.cjs');
const pages=new PageNavigation();let pageTimer;const pageHotkeyFailures=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.setPath('userData',path.join(app.getPath('appData'),'mono-deck'));
app.setAppUserModelId('studio.monodeck.desktop');
let win,tray,bridge,keyboard,runner,modes,config,configFile,manualProfile,quitting=false,trayNoticeShown=false,executionEpoch=0,quitAfterWrite=false;
let presetReview=null,obsController=null;
function obs(){
  if(!obsController){
    const {ObsClient,ObsController,localConnection}=require('./obs.cjs');
    const client=new ObsClient({getConnection:()=>localConnection(app.getPath('appData'))});
    obsController=new ObsController({client,getTargets:()=>{try{return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'obs-targets.json'),'utf8'));}catch{return {};}},onFeedback:state=>{log(`${state.title} · ${state.detail}`);require('./page-hud.cjs').show(state);}});
  }return obsController;
}
let recording={active:false,starting:false,steps:[],lastTime:0,generation:0};
let recordingStop=null;
const events=[];let lastForeground='',foregroundBusy=false,refreshBusy=false;
function publish(event){const entry={time:new Date().toISOString(),...event};events.push(entry);if(events.length>150)events.shift();if(win&&!win.isDestroyed())win.webContents.send('deck:event',entry);}
function log(message,level='info'){publish({type:'log',message,level});}
function persist(){const tmp=configFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(config,null,2));fs.renameSync(tmp,configFile);}
function status(){return {...keyboard.status,bridgeReady:bridge.ready};}
function notifyStatus(){publish({type:'status',device:status()});}
function currentMode(){return config.pageMode==='onboard'?'onboard':'pc';}
function pageState(){return {...pages.state(config,keyboard?.status.activeLayer),activeId:currentMode()==='onboard'?ONBOARD_ID:config.activeProfile,mode:currentMode(),hardwareMode:modes?.groups[keyboard?.status.activeLayer]?.mode||'unknown',lastConfirmedAt:keyboard?.status.activeLayerAt||null,groupConfirmed:!!keyboard?.status.activeLayer,groups:modes?.state().groups||{},transition:modes?.transition||null,error:modes?.error||null,hotkeyFailures:[...pageHotkeyFailures]};}
function announcePage(show=true){
  const page=pageState();publish({type:'page',page});
  if(show)require('./page-hud.cjs').show(page);
}
function cancelPage(){clearTimeout(pageTimer);pages.candidate=null;announcePage(false);require('./page-hud.cjs').hide();}
function setProfile(id,manual=false,stopRunning=true){
  if(!config.profiles.some(p=>p.id===id))throw new Error('PC 페이지를 찾을 수 없습니다.');
  if(manual)manualProfile=id;
  clearTimeout(pageTimer);pages.candidate=null;
  if(config.activeProfile!==id||currentMode()!=='pc'){
    if(stopRunning&&runner?.current)void runner.stop('PC 페이지 전환으로 매크로를 중지했습니다.');
    config.activeProfile=id;config.pageMode='pc';updateHotkeys();publish({type:'config',config});log(`PC 페이지 전환 · ${config.profiles.find(p=>p.id===id).name}`);
  }
  if(manual)persist();announcePage();
}
async function navigatePage(operation,id){
  if(recording.active||recording.starting)throw new Error('녹화를 중지한 뒤 PC 페이지를 전환하세요.');
  modes.assertIdle();
  clearTimeout(pageTimer);
  const navConfig={...config,includeOnboard:true,activeProfile:currentMode()==='onboard'?ONBOARD_ID:config.activeProfile};
  const selected=pages.apply(navConfig,operation==='onboard'?'select':operation,operation==='onboard'?ONBOARD_ID:id);
  if(selected){
    if(selected===ONBOARD_ID){
      // Registering the pressed global shortcut again can enqueue another Windows
      // hotkey event. An already-selected zero must not re-register or persist.
      if(currentMode()!=='onboard'){
        if(runner?.current)void runner.stop('0번 프리셋으로 전환했습니다.');
        config.pageMode='onboard';persist();updateHotkeys();publish({type:'config',config});
      }
      announcePage();
    }else setProfile(selected,true);
  }
  else if(operation==='cancel')cancelPage();
  else {announcePage();if(pages.candidate)pageTimer=setTimeout(cancelPage,8000);}
  return pageState();
}
function navigateSafely(operation,id){void navigatePage(operation,id).catch(error=>{log(error.message,'warning');announcePage(false);});}
async function executeExternal(action,job){
  switch(action.type){
    case 'url':{let url;try{url=new URL(action.url);}catch{throw new Error('올바른 URL을 입력하세요.');}if(!['http:','https:'].includes(url.protocol))throw new Error('웹사이트는 http/https만 지원합니다.');return shell.openExternal(url.href);}
    case 'app':{
      if(!action.path||!action.path.toLowerCase().endsWith('.exe'))throw new Error('실행할 .exe 경로를 입력하세요.');
      return new Promise((resolve,reject)=>{const child=spawn(action.path,action.args||[],{detached:true,stdio:'ignore',shell:false,windowsHide:false});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
    }
    case 'profile':return navigatePage('select',action.profileId);
    case 'page':return navigatePage(action.pageOperation,action.profileId);
    case 'obs':return obs().execute(action,()=>{if(job)runner.check(job);});
    default:throw new Error('지원하지 않는 동작');
  }
}
function dispatch(input,origin='hardware'){
  const layer=typeof input==='string'?3:input.layer;let control=typeof input==='string'?input:input.control;
  if(config.knobDirection?.[control.split('.')[0]])control=control.endsWith('.cw')?control.replace('.cw','.ccw'):control.endsWith('.ccw')?control.replace('.ccw','.cw'):control;
  if(origin==='hardware'){keyboard.status.activeLayer=layer;keyboard.status.activeLayerAt=new Date().toISOString();notifyStatus();announcePage(false);}
  publish({type:'input',control,layer,message:`L${layer} · ${control}`});
  if(modes.transition)return;
  const nav=defaultCommonBindings(config.knobOrder[1])[control];
  if(nav){navigateSafely(nav.pageOperation);return;}
  if(modes.groups[layer]?.mode!=='pc')return;
  const profile=config.profiles.find(p=>p.id===config.activeProfile);
  let action;
  try{action=currentMode()==='onboard'?modes.presetBindings(layer)[control]:resolveBindings(config,profile,layer)[control];}
  catch(error){log(error.message,'warning');return;}
  if(!action||action.type==='none'||action.disabled)return;
  if(action.type==='page'||action.type==='profile'){navigateSafely(action.type==='profile'?'select':action.pageOperation,action.profileId);return;}
  const source=`${currentMode()==='onboard'?ONBOARD_ID:profile.id}:${layer}:${control}`;
  if(action.type==='stop'||(action.repeatMode==='toggle'&&runner.current?.source===source)){void runner.stop();return;}
  if(!config.enabled||recording.active||recording.starting)return;
  // Editing is also live input monitoring: avoid firing Ctrl+W/zoom/delete at
  // this editor when the user is identifying physical controls.
  if(win&&!win.isDestroyed()&&win.isFocused())return;
  void runner.run(action,{source}).then(result=>{if(!result.ok&&!result.cancelled)log(result.error,'error');});
}
function updateHotkeys(){
  if(!globalShortcut)return;globalShortcut.unregisterAll();pageHotkeyFailures.length=0;const used=new Set();const profile=config.profiles.find(p=>p.id===config.activeProfile);
  if(config.pageHotkeys)for(let number=0;number<=9;number++){
    const accelerator=`Ctrl+Alt+${number}`;used.add(accelerator.toLowerCase());
    try{if(!globalShortcut.register(accelerator,()=>{if(number===0){navigateSafely('onboard');return;}const target=config.profiles[number-1];if(target)navigateSafely('select',target.id);else log(`${number}번 PC 페이지가 없습니다.`,'warning');}))throw new Error('다른 앱에서 사용 중');}
    catch(e){pageHotkeyFailures.push(accelerator);log(`페이지 단축키 등록 실패: ${accelerator} · ${e.message}`,'warning');}
  }
  if(currentMode()==='onboard')return;
  for(const layer of [1,2,3])for(const [control,a] of Object.entries(resolveBindings(config,profile,layer)))if(!defaultCommonBindings(config.knobOrder[1])[control]&&a.hotkey?.trim()){
    const accelerator=a.hotkey.trim();if(used.has(accelerator.toLowerCase())){if(config.commonBindings?.[control]===a&&layer!==1)continue;log(`중복 시작 단축키: ${accelerator}`,'warning');continue;}used.add(accelerator.toLowerCase());
    try{if(!globalShortcut.register(accelerator,()=>dispatch({control,layer},'hotkey')))log(`시작 단축키를 등록하지 못했습니다: ${accelerator}`,'warning');}catch(e){log(`시작 단축키 오류: ${e.message}`,'warning');}
  }
}
async function stopEverything(message='매크로를 중지했습니다.'){
  executionEpoch++;recording.generation++;recording.starting=false;
  const stopped=runner.stop(message);
  if(recording.active||recordingStop)await stopRecording();
  else publish({type:'recording',recording:false,starting:false,count:recording.steps.length,message:'녹화 중지'});
  return stopped;
}
async function stopRecording(){
  recording.generation++;recording.starting=false;
  if(recordingStop)return recordingStop;
  recordingStop=(async()=>{
    // Native flushes balanced releases before replying. Keep accepting those
    // events until recordStop finishes, including emergency-stop flushes.
    try{await bridge.request('recordStop');}catch(e){log(e.message,'warning');}
    finally{recording.active=false;publish({type:'recording',recording:false,starting:false,count:recording.steps.length,message:'녹화를 멈췄습니다.'});}
    return recording.steps;
  })();
  try{return await recordingStop;}finally{recordingStop=null;}
}
function receiveRecording(message){
  if(!recording.active)return;const e=message.event||{};let action;
  if(e.type==='key')action={type:'key',label:`${e.key} ${e.state==='down'?'누름':'뗌'}`,key:e.key,state:e.state};
  else if(e.type==='mouse')action={type:'mouse',label:`마우스 ${e.action}`,mouseAction:e.action,x:e.x,y:e.y,button:e.button,delta:e.delta,relative:false};else return;
  try{action=validateAction(action);}catch(e){log(e.message,'warning');return;}
  const time=typeof message.timestamp==='number'?message.timestamp:recording.lastTime;const gap=Math.max(0,Math.min(3600000,time-recording.lastTime));recording.lastTime=time;
  if(recording.steps.length+(gap>0?2:1)>499)return;
  if(gap>0)recording.steps.push({type:'delay',label:'녹화 간격',delayMs:gap});
  recording.steps.push(action);
  publish({type:'recording',recording:true,count:recording.steps.length,message:`${recording.steps.length}개 단계 녹화 중`});
  if(recording.steps.length>=480&&!recordingStop){void stopRecording();log('녹화 단계 상한에 도달해 자동으로 중지했습니다.');}
}
function register(channel,handler){ipcMain.handle(`deck:${channel}`,async(event,...args)=>{
  const valid=win&&!win.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame;
  if(!valid)throw new Error('Untrusted sender');return handler(...args);
});}
async function refresh(){if(refreshBusy||keyboard.busy||modes?.transition)return status();refreshBusy=true;try{await keyboard.refresh();modes?.sync();notifyStatus();announcePage(false);return status();}finally{refreshBusy=false;}}
function createWindow(){
  const area=screen?.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea||{x:0,y:0,width:1920,height:1080};
  const width=Math.min(1720,area.width-32),height=Math.min(1120,area.height-32);
  win=new BrowserWindow({title:'MONO DECK',width,height,x:Math.round(area.x+(area.width-width)/2),y:Math.round(area.y+(area.height-height)/2),minWidth:Math.min(1200,width),minHeight:Math.min(740,height),backgroundColor:'#111410',show:false,autoHideMenuBar:true,icon:path.join(__dirname,'../../assets/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('did-finish-load',()=>win.webContents.setZoomFactor(1));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.on('close',event=>{if(!quitting){event.preventDefault();win.hide();if(!trayNoticeShown&&tray){trayNoticeShown=true;tray.displayBalloon({title:'MONO DECK이 트레이에서 실행 중입니다',content:'아이콘을 두 번 클릭하면 창이 다시 열립니다. 완전히 종료하려면 트레이 메뉴의 종료를 선택하세요.'});}}});
  win.once('ready-to-show',()=>{if(!process.argv.includes('--hidden')){win.show();setTimeout(()=>win&&!win.isDestroyed()&&win.show(),200);}});
  win.loadFile(path.join(__dirname,'../../dist/index.html'));
}
function updateTray(){tray?.setContextMenu(Menu.buildFromTemplate([{label:'MONO DECK 열기',click:()=>{win.show();win.focus();}},{label:'실행 중인 매크로 중지',click:()=>void stopEverything()},{label:config.enabled?'매크로 일시 정지':'매크로 활성화',click:()=>{config.enabled=!config.enabled;if(!config.enabled)void stopEverything();persist();publish({type:'config',config});updateTray();}},{type:'separator'},{label:'종료',click:()=>{quitting=true;app.quit();}}]));}
if(!app.requestSingleInstanceLock())app.quit();
else{
app.on('second-instance',(_event,argv)=>{if(argv.includes('--quit')){quitting=true;app.quit();return;}if(win){win.show();if(win.isMinimized())win.restore();win.focus();}});
app.whenReady().then(async()=>{
  configFile=path.join(app.getPath('userData'),'profiles.json');fs.mkdirSync(app.getPath('userData'),{recursive:true});
  try{const raw=JSON.parse(fs.readFileSync(configFile,'utf8'));config=validateConfig(raw);if(raw.schemaRevision!==3){fs.copyFileSync(configFile,configFile+'.before-v3-'+Date.now());for(const p of config.profiles)for(const layer of [1,2,3])for(const direction of ['ccw','cw','press'])delete p.layers[layer][`knob${config.knobOrder[1]}.${direction}`];persist();}}catch(e){config=validateConfig(defaults());if(fs.existsSync(configFile)){fs.copyFileSync(configFile,configFile+'.invalid-'+Date.now());log('프로필 파일을 읽지 못해 보관하고 기본값을 불러왔습니다.','warning');}persist();}
  manualProfile=config.activeProfile;
  keyboard=new Keyboard(path.join(app.getPath('userData'),'backups'));
  bridge=new Bridge(app.isPackaged?path.join(process.resourcesPath,'native/MacroBridge.exe'):path.join(__dirname,'../../native/bin/MacroBridge.exe'));
  runner=new MacroRunner({bridge,isEditorFocused:()=>!!win&&!win.isDestroyed()&&win.isFocused(),executeExternal,onEvent:publish});
  modes=new ModeManager({keyboard,directory:path.join(app.getPath('userData'),'onboard-banks'),getConfig:()=>config,beforeSwitch:()=>stopEverything('기기 모드 전환으로 매크로를 중지했습니다.'),onChange:()=>{notifyStatus();announcePage(true);}});
  bridge.on('ready',metadata=>{keyboard.status.emergencyHotkeyRegistered=metadata?.emergencyHotkeyRegistered===true;notifyStatus();log('Windows 입력 서비스 연결 완료');if(metadata?.emergencyHotkeyRegistered===false)log('Ctrl+Alt+Esc 등록 실패: 다른 프로그램이 사용 중일 수 있습니다. UI 중지 버튼을 사용하세요.','warning');});bridge.on('diagnostic',message=>log(message,'error'));bridge.on('disconnected',()=>{void runner.stop('입력 서비스 연결이 끊겼습니다.');delete keyboard.status.activeLayer;delete keyboard.status.activeLayerAt;notifyStatus();announcePage(false);log('Windows 입력 서비스 연결 끊김. 앱을 다시 시작하세요.','error');});
  bridge.on('message',message=>{
    if(message.type==='input'){const input=keyboard.inputMap.get(message.fingerprint);if(input)dispatch(input);else publish({type:'unmapped',message:`입력 감지 · ${message.fingerprint} (기기 레이어 설정 확인)`});}
    else if(message.type==='emergencyStop'){config.enabled=false;void stopEverything('Ctrl+Alt+Esc 긴급 중지');persist();publish({type:'config',config});updateTray();}
    else if(message.type==='record')receiveRecording(message);
    else if(message.type==='recordingError'){void stopRecording();log(message.error||message.message||'녹화가 중지되었습니다.','error');}
    else if(message.type==='error')log(message.error,'error');
  });
  createWindow();
  const icon=nativeImage.createFromPath(path.join(__dirname,'../../assets/icon.png'));tray=new Tray(icon.resize({width:24,height:24}));tray.setToolTip('MONO DECK · A73T');tray.on('double-click',()=>{win.show();win.focus();});updateTray();
  register('getState',()=>({config,device:status(),events,page:pageState(),macro:runner.state,recording:{recording:recording.active,starting:recording.starting,count:recording.steps.length}}));
  register('navigatePage',(operation,id)=>navigatePage(operation,id));
  register('previewProfileDeletion',id=>previewProfileDeletion(config,id));
  register('deleteProfile',(id,reviewHash)=>{
    modes.assertIdle();if(recording.active||recording.starting)throw new Error('녹화를 중지한 뒤 PC 페이지를 삭제하세요.');
    if(typeof reviewHash!=='string')throw new Error('삭제할 페이지를 다시 열어 확인하세요.');
    const review=previewProfileDeletion(config,id),next=removeProfile(config,id,{detachReferences:true,expectedHash:reviewHash}),removed=config.profiles.find(p=>p.id===id);
    const directory=path.join(app.getPath('userData'),'page-backups');fs.mkdirSync(directory,{recursive:true});
    const backupPath=path.join(directory,`before-delete-${Date.now()}-${require('node:crypto').randomUUID()}.json`);
    fs.writeFileSync(backupPath,JSON.stringify(config,null,2),{flag:'wx'});
    const previous=config;try{config=next;persist();}catch(error){config=previous;throw error;}
    void stopEverything('PC 페이지 삭제로 매크로를 중지했습니다.');
    manualProfile=config.activeProfile;lastForeground='';modes.sync();updateHotkeys();publish({type:'config',config});updateTray();cancelPage();
    log(`PC 페이지 삭제 · ${removed.name} · 연결 ${review.references.length}개 해제 · 삭제 전 백업: ${backupPath}`);
    return {config,backupPath,detachedCount:review.references.length};
  });
  register('saveConfig',input=>{modes.assertIdle();const next=validateConfig(input);const switched=config.activeProfile!==next.activeProfile||config.pageMode!==next.pageMode;if(switched&&runner.current)void runner.stop('PC 페이지 전환으로 매크로를 중지했습니다.');if(config.enabled&&!next.enabled)void stopEverything();config=next;manualProfile=config.activeProfile;lastForeground='';persist();modes.sync();updateHotkeys();publish({type:'config',config});updateTray();clearTimeout(pageTimer);pages.candidate=null;announcePage(switched);return config;});
  register('refreshDevice',refresh);
  register('backupDevice',async()=>{const result=await keyboard.backup();log(`키·노브 매핑 백업 완료 · ${result.path}`);return result;});
  register('provisionDevice',async(layers=[config.selectedLayer])=>{modes.assertIdle();for(const layer of layers)await modes.activate('pc',layer);notifyStatus();return {ok:true,message:`기기 그룹 ${layers.join(', ')} PC 연결 완료 · 온보드 0 원본 보관됨`};});
  register('restoreDevice',async(layers=[config.selectedLayer])=>{modes.assertIdle();const choice=await dialog.showOpenDialog(win,{title:`선택 레이어 매핑 복원 (${layers.join(', ')})`,defaultPath:keyboard.directory,filters:[{name:'MONO DECK 매핑 백업',extensions:['json']}],properties:['openFile']});if(choice.canceled)return {ok:false,message:'취소했습니다.'};await stopEverything();const result=await keyboard.restore(choice.filePaths[0],layers);modes.sync();notifyStatus();announcePage(false);log(result.message);return result;});
  register('testAction',async input=>{modes.assertIdle();return input?.type==='page'?{ok:true,page:await navigatePage(validateAction(input).pageOperation,input.profileId)}:runner.run(input,{allowEditor:true,delayBeforeMs:['shortcut','text','sequence','key','mouse'].includes(input?.type)?2000:0,source:'explicit-test'});});
  register('runMacro',(input,options={})=>{modes.assertIdle();if(recording.active||recording.starting)throw new Error('녹화를 먼저 중지하세요.');if(!options.dryRun)log('2초 뒤 매크로 실행 · 대상 앱으로 전환하세요.');return runner.run(input,{dryRun:options.dryRun===true,allowEditor:options.dryRun===true,delayBeforeMs:options.dryRun?0:2000,source:'studio'});});
  register('stopMacro',()=>stopEverything());
  register('openTestPad',()=>require('./testpad.cjs').openTestPad({parent:win,runner,bridge,directory:app.getPath('userData'),stopEverything,log}));
  register('readOnboard',async()=>{modes.assertIdle();const result=await keyboard.readOnboard();modes.sync();notifyStatus();announcePage(false);return Array.isArray(result)?{entries:result}:{...result,entries:result.entries||result.slots||[]};});
  register('readOnboardBank',layer=>{if(![1,2,3].includes(layer))throw new Error('기기 그룹을 선택하세요.');return {entries:require('./onboard.cjs').decodeReports(modes.bank(layer),[layer]),hash:modes.bankHash(layer),...modes.groups[layer]};});
  register('saveZeroPreset',(entries,options)=>{modes.assertIdle();const result=modes.savePreset(entries,options);log(result.message);return result;});
  register('applyZeroPreset',async(layer,expectedHash)=>{modes.assertIdle();const result=await modes.applyPreset(layer,expectedHash);notifyStatus();log(result.message);return result;});
  register('importZeroPreset',async layer=>{modes.assertIdle();const result=await modes.capturePreset(layer);notifyStatus();log(result.message);return result;});
  register('planOnboard',entries=>modes.plan(entries));
  register('uploadOnboard',async(entries,options)=>{const result=await modes.saveOnboard(entries,options);notifyStatus();log(result.message);return result;});
  register('restoreAppSlots',async slots=>{modes.assertIdle();const selected=require('./onboard.cjs').selection(slots);for(const layer of [...new Set(selected.map(s=>s.layer))])await modes.activate('pc',layer);return {ok:true,message:'선택한 기기 그룹을 PC 모드로 전환했습니다. 온보드 0 원본은 유지됩니다.'};});
  register('getMonitors',()=>bridge.request('monitors'));
  register('getCursor',async(delayMs=2000)=>{if(!Number.isInteger(delayMs)||delayMs<0||delayMs>10000)throw new Error('좌표 캡처 대기 시간이 올바르지 않습니다.');if(delayMs)await pause(delayMs);const p=await bridge.request('cursor');const {monitors}=await bridge.request('monitors');const m=monitors.find(m=>p.x>=m.left&&p.x<m.left+m.width&&p.y>=m.top&&p.y<m.top+m.height);return {...p,monitorId:m?.id,localX:m?p.x-m.left:p.x,localY:m?p.y-m.top:p.y};});
  register('getPixel',async(x,y,monitorId)=>bridge.request('pixel',await runner.point({x,y,monitorId,coordinateSpace:monitorId?'monitor':'desktop'})));
  register('getLightingCapabilities',()=>({supported:true,factoryOnly:true,modes:lightingModes.map(id=>({id,name:({off:'끄기',backlight:'상시 점등',shock:'내장 패턴 2',shock2:'내장 패턴 3',press:'누를 때 점등'})[id]})),colors:lightingColors.map(id=>({id,name:({white:'흰색',red:'빨강',orange:'주황',yellow:'노랑',green:'초록',cyan:'청록',blue:'파랑',purple:'보라'})[id]})),note:'기기 내장 효과입니다. 조명 상태 읽기는 지원되지 않아 표시값은 마지막 요청값입니다. 백색은 상시 점등/끄기만 지원합니다.'}));
  register('setLighting',async settings=>{modes.assertIdle();const result=await keyboard.setLighting(settings);notifyStatus();log(result.message);return result;});
  register('startRecording',async(options={})=>{modes.assertIdle();
    await stopEverything();const generation=++recording.generation;recording={...recording,starting:true,active:false,steps:[],lastTime:0};publish({type:'recording',recording:false,starting:true,count:0,message:'2초 후 녹화 시작 · 대상 앱으로 이동하세요.'});
    try{
      await pause(2000);if(generation!==recording.generation)return {ok:false,message:'녹화를 취소했습니다.'};
      await bridge.request('resume');if(generation!==recording.generation)return {ok:false};
      recording.active=true;await bridge.request('recordStart',{mouseMove:options.mouseMove===true,excludeProcessId:process.pid});
      if(generation!==recording.generation){await stopRecording();return {ok:false};}
      recording.starting=false;publish({type:'recording',recording:true,count:recording.steps.length,message:'키보드·마우스 녹화 중'});return {ok:true};
    }catch(e){await stopRecording();throw e;}
    finally{if(generation===recording.generation)recording.starting=false;}
  });
  register('stopRecording',stopRecording);
  register('exportConfig',async()=>{const result=await dialog.showSaveDialog(win,{defaultPath:'mono-deck-profiles.json',filters:[{name:'MONO DECK Profiles',extensions:['json']}]});if(result.canceled)return {ok:false};fs.writeFileSync(result.filePath,JSON.stringify(config,null,2));return {ok:true};});
  register('previewPreset',async source=>{
    if(!['builtin','file','obsMixer'].includes(source))throw new Error('프리셋 종류를 선택하세요.');
    let file=path.join(__dirname,source==='obsMixer'?'../../assets/obs-mixer.monodeck.json':'../../assets/work-starter.monodeck.json');
    if(source==='file'){const choice=await dialog.showOpenDialog(win,{title:'새 페이지로 추가할 프리셋 파일',filters:[{name:'MONO DECK 프리셋 / 설정',extensions:['json']}],properties:['openFile']});if(choice.canceled)return null;file=choice.filePaths[0];}
    if(fs.statSync(file).size>2*1024*1024)throw new Error('프리셋 파일은 2MB 이하여야 합니다.');
    const {parsePack,previewPack}=require('./presets.cjs');const pack=parsePack(JSON.parse(fs.readFileSync(file,'utf8')));
    const token=require('node:crypto').randomUUID();presetReview={token,pack};return {token,...previewPack(pack,config)};
  });
  register('addPreset',(token,ids)=>{
    modes.assertIdle();if(!presetReview||token!==presetReview.token)throw new Error('프리셋 파일을 다시 열어 검토하세요.');
    const result=require('./presets.cjs').mergePack(config,presetReview.pack,ids);
    if(result.added.length){fs.copyFileSync(configFile,configFile+'.before-presets-'+Date.now());const previous=config;try{config=result.config;persist();}catch(error){config=previous;throw error;}publish({type:'config',config});announcePage(false);log(`기존 설정 유지 · PC 페이지 ${result.added.length}개 추가`);}
    return {...result,config};
  });
  register('exportPreset',async ids=>{
    const pack=require('./presets.cjs').exportPack(config,ids);const result=await dialog.showSaveDialog(win,{title:'선택한 PC 페이지를 프리셋으로 내보내기',defaultPath:'mono-deck-preset.monodeck.json',filters:[{name:'MONO DECK 프리셋',extensions:['json']}]});if(result.canceled)return {ok:false};fs.writeFileSync(result.filePath,JSON.stringify(pack,null,2));return {ok:true};
  });
  register('inspectObs',async()=>{obs().client.disconnect();obs().selectedAudio=null;return obs().inspect();});
  register('saveObsTargets',async input=>{
    const inventory=await obs().inspect();const targets=require('./obs.cjs').validateTargets(input,inventory.audio);
    const file=path.join(app.getPath('userData'),'obs-targets.json');fs.writeFileSync(file+'.tmp',JSON.stringify(targets,null,2));fs.renameSync(file+'.tmp',file);return targets;
  });
  register('importConfig',async()=>{modes.assertIdle();const choice=await dialog.showOpenDialog(win,{filters:[{name:'MONO DECK Profiles',extensions:['json']}],properties:['openFile']});if(choice.canceled)return null;const file=choice.filePaths[0];if(fs.statSync(file).size>2*1024*1024)throw new Error('프로필 파일은 2MB 이하여야 합니다.');const imported=validateConfig(JSON.parse(fs.readFileSync(file,'utf8')));imported.enabled=false;imported.startAtLogin=config.startAtLogin;fs.copyFileSync(configFile,configFile+'.before-import');await stopEverything();config=imported;manualProfile=config.activeProfile;persist();updateHotkeys();publish({type:'config',config});updateTray();cancelPage();log('프로필을 가져왔습니다. 동작을 검토한 뒤 매크로를 활성화하세요.');return config;});
  register('setLogin',enabled=>{if(typeof enabled!=='boolean')throw new Error('Invalid login setting');app.setLoginItemSettings({openAtLogin:enabled,path:process.execPath,args:app.isPackaged?['--hidden']:[app.getAppPath(),'--hidden']});config.startAtLogin=enabled;persist();return enabled;});
  register('openDataFolder',()=>shell.openPath(app.getPath('userData')));
  bridge.start();updateHotkeys();await refresh();log(keyboard.status.connected?`A73T 연결 · ${keyboard.status.totalMappedControls||keyboard.status.mappedControls}개 앱 입력 확인`:'키보드를 연결한 뒤 새로고침하세요.');
  setInterval(async()=>{if(keyboard.busy||refreshBusy||modes.transition)return;try{const list=await require('node-hid').devicesAsync(0x1189,0x8840);const connected=list.some(d=>d.usagePage===0xff00&&d.usage===1);if(connected!==keyboard.status.connected){if(connected)await refresh();else{keyboard.status.connected=false;delete keyboard.status.activeLayer;delete keyboard.status.activeLayerAt;keyboard.inputMap.clear();modes.sync();notifyStatus();announcePage(false);log('키보드 연결 해제','warning');}}}catch(e){log(e.message,'error');}},4000).unref();
  setInterval(async()=>{if(foregroundBusy||modes.transition||currentMode()!=='pc'||!bridge.ready||!config.enabled||pages.candidate||recording.active||recording.starting)return;foregroundBusy=true;try{const foreground=await bridge.request('foreground');const processName=foreground.process.toLowerCase();if(['mono deck','electron'].includes(processName))return;if(processName===lastForeground)return;lastForeground=processName;const matched=config.profiles.find(p=>p.matchProcess&&p.matchProcess.toLowerCase().replace(/\.exe$/,'')===processName);const target=matched?.id||manualProfile;if(target!==config.activeProfile)setProfile(target);}catch{}finally{foregroundBusy=false;}},1200).unref();
}).catch(e=>{dialog.showErrorBox('MONO DECK 시작 오류',e.stack||e.message);quitting=true;app.quit();});
app.on('before-quit',event=>{
  if(modes?.operation){event?.preventDefault();if(!quitAfterWrite){quitAfterWrite=true;const finish=()=>app.quit();modes.operation.then(finish,finish);}return;}
  clearTimeout(pageTimer);quitting=true;executionEpoch++;recording.generation++;globalShortcut?.unregisterAll();bridge?.stop();obsController?.client.disconnect();
});
app.on('window-all-closed',()=>{});
}
