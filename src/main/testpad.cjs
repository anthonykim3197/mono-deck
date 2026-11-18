const {BrowserWindow,ipcMain,screen}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
let pad;
const expected='MONO DECK 복합 매크로 테스트 성공 ✓';
function openTestPad({parent,runner,bridge,directory,stopEverything,log}){
  if(pad&&!pad.isDestroyed()){pad.show();pad.focus();return {ok:true};}
  const window=pad=new BrowserWindow({title:'MONO DECK · 혼합 매크로 테스트',width:900,height:760,resizable:false,movable:false,maximizable:false,minimizable:false,parent,show:false,autoHideMenuBar:true,backgroundColor:'#111610',webPreferences:{preload:path.join(__dirname,'testpad-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  let active=false,last=null;
  const valid=event=>event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame;
  const channels=['testpad:start','testpad:finish','testpad:close'];
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',e=>e.preventDefault());
  window.webContents.on('did-finish-load',()=>window.webContents.setZoomFactor(1));
  window.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.key==='Escape'&&!input.isComposing){event.preventDefault();window.close();}});
  window.on('close',()=>{if(active)void runner.stop('테스트 창을 닫아 중지했습니다.');});
  window.on('closed',()=>{for(const channel of channels)ipcMain.removeHandler(channel);if(pad===window)pad=null;});
  ipcMain.handle('testpad:start',async(event,rect)=>{
    if(!valid(event))throw new Error('Untrusted test sender');if(active)throw new Error('테스트가 진행 중입니다.');
    let bounds=window.getContentBounds();
    if(!rect||['x','y','width','height'].some(k=>!Number.isFinite(rect[k]))||rect.width<50||rect.height<30||rect.x<0||rect.y<0||rect.x+rect.width>bounds.width+1||rect.y+rect.height>bounds.height+1)throw new Error('테스트 입력란의 위치를 확인하지 못했습니다.');
    active=true;
    try{
    await stopEverything();if(window.isDestroyed())return {ok:false};window.focus();bounds=window.getContentBounds();
    const point=screen.dipToScreenPoint({x:Math.round(bounds.x+rect.x+rect.width/2),y:Math.round(bounds.y+rect.y+rect.height/2)});
    const handle=window.getNativeWindowHandle();const hwnd=(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString();
    const action={type:'sequence',label:'마우스 이동 → 클릭 → 딜레이 → 단축키 → 문자 입력',steps:[
      {type:'mouse',label:'테스트 입력란으로 이동',mouseAction:'move',x:point.x,y:point.y,coordinateSpace:'desktop'},
      {type:'mouse',label:'왼쪽 클릭',mouseAction:'click',button:'left',clicks:1},
      {type:'delay',label:'500 ms 대기',delayMs:500},
      {type:'shortcut',label:'기존 글자 전체 선택',keys:['CTRL','A']},
      {type:'text',label:'한글·문자 입력',text:expected},
      {type:'key',label:'F8 누르기',key:'F8',state:'down'},
      {type:'key',label:'F8 떼기',key:'F8',state:'up'}
    ]};
    const id=randomUUID();last={id,at:new Date().toISOString(),point,action,expected};
      const result=await runner.run(action,{allowEditor:true,outputGuard:{requiredForegroundWindow:hwnd},targetAllowed:()=>!window.isDestroyed()&&window.isFocused(),source:'controlled-testpad',delayBeforeMs:200});
      last.result=result;last.cursor=await bridge.request('cursor').catch(()=>null);return {id,...result,point,expected,action};
    }finally{active=false;}
  });
  ipcMain.handle('testpad:finish',async(event,evidence)=>{
    if(!valid(event)||!last||evidence?.id!==last.id)throw new Error('Invalid test result');
    const observed={value:String(evidence.value||'').slice(0,1000),moved:evidence.moved===true,clicked:evidence.clicked===true,ctrlA:evidence.ctrlA===true,f8Down:evidence.f8Down===true,f8Up:evidence.f8Up===true,delayMs:Number(evidence.delayMs)};
    const ok=last.result?.ok===true&&observed.value===expected&&observed.moved&&observed.clicked&&observed.ctrlA&&observed.f8Down&&observed.f8Up&&Number.isFinite(observed.delayMs)&&observed.delayMs>=450;
    const report={...last,observed,ok,scope:'Controlled visible testpad only; real Windows mouse/keyboard injection and renderer-observed events.'};
    fs.mkdirSync(path.join(directory,'tests'),{recursive:true});const file=path.join(directory,'tests','mixed-macro-latest.json');fs.writeFileSync(file,JSON.stringify(report,null,2));
    log(ok?`복합 매크로 실물 출력 성공 · 클릭 후 ${Math.round(observed.delayMs)} ms · 문자/단축키/키 누름·뗌 확인`:'복합 매크로 테스트 결과를 확인하세요.',ok?'info':'warning');
    return {ok,path:file,observed};
  });
  ipcMain.handle('testpad:close',event=>{if(valid(event))window.close();});
  window.once('ready-to-show',()=>{window.show();window.focus();});window.loadFile(path.join(__dirname,'testpad.html'));return {ok:true};
}
module.exports={openTestPad};
