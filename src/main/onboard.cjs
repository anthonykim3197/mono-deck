// Portable 884x mappings. This module only compiles/decodes; it never opens HID.
const {createHash}=require('node:crypto');
const {controls,packet,mappingPacket,validateReports}=require('./protocol.cjs');
const {validateAction}=require('./config.cjs');
const modifiers={CTRL:1,CONTROL:1,LCTRL:1,SHIFT:2,LSHIFT:2,ALT:4,LALT:4,WIN:8,META:8,SUPER:8,LWIN:8,RCTRL:16,RSHIFT:32,RALT:64,RWIN:128};
const modifierNames=['CTRL','SHIFT','ALT','WIN','RCTRL','RSHIFT','RALT','RWIN'];
const usages={};
for(let i=0;i<26;i++)usages[String.fromCharCode(65+i)]=4+i;
for(let i=1;i<=9;i++)usages[String(i)]=0x1d+i;
usages['0']=0x27;
Object.assign(usages,{ENTER:0x28,ESC:0x29,BACKSPACE:0x2a,TAB:0x2b,SPACE:0x2c,MINUS:0x2d,EQUAL:0x2e,BRACKETLEFT:0x2f,BRACKETRIGHT:0x30,BACKSLASH:0x31,SEMICOLON:0x33,QUOTE:0x34,BACKQUOTE:0x35,COMMA:0x36,PERIOD:0x37,SLASH:0x38,CAPSLOCK:0x39,PRINTSCREEN:0x46,SCROLLLOCK:0x47,PAUSE:0x48,INSERT:0x49,HOME:0x4a,PAGEUP:0x4b,DELETE:0x4c,END:0x4d,PAGEDOWN:0x4e,RIGHT:0x4f,LEFT:0x50,DOWN:0x51,UP:0x52,NUMLOCK:0x53,NUMPADDIVIDE:0x54,NUMPADMULTIPLY:0x55,NUMPADSUBTRACT:0x56,NUMPADADD:0x57,NUMPADENTER:0x58,NUMPAD0:0x62,NUMPADDECIMAL:0x63,APPS:0x65});
for(let i=1;i<=12;i++)usages['F'+i]=0x39+i;
for(let i=1;i<=9;i++)usages['NUMPAD'+i]=0x58+i;
for(let i=13;i<=24;i++)usages['F'+i]=0x68+i-13;
const usageNames=Object.fromEntries(Object.entries(usages).map(([name,code])=>[code,name]));
const aliases={RETURN:'ENTER',ESCAPE:'ESC',DEL:'DELETE',ARROWLEFT:'LEFT',ARROWRIGHT:'RIGHT',ARROWUP:'UP',ARROWDOWN:'DOWN','-':'MINUS','=':'EQUAL','+':'EQUAL',PLUS:'EQUAL','[':'BRACKETLEFT',']':'BRACKETRIGHT','\\':'BACKSLASH',';':'SEMICOLON',"'":'QUOTE','`':'BACKQUOTE',',':'COMMA','.':'PERIOD','/':'SLASH'};
const mediaUsages={volumeUp:0xe9,volumeDown:0xea,mute:0xe2,playPause:0xcd,next:0xb5,previous:0xb6,stop:0xb7};
const mediaNames=Object.fromEntries(Object.entries(mediaUsages).map(([name,code])=>[code,name]));
const warnings=[
  '기기에 저장된 기본 입력은 MONO DECK 없이도 전송됩니다. 다른 PC의 앱·키보드 배열에 따라 결과가 달라질 수 있습니다.',
  '기존 펌웨어 지연값은 조회하거나 변경하지 않습니다. 연속 키의 입력 간격은 보장하지 않습니다.',
  '이름·아이콘·프로필·전역 실행 단축키는 PC에 저장되며 기기에서 읽을 수 없습니다.'
];
function selection(entries){
  if(!Array.isArray(entries)||!entries.length||entries.length>72)throw new Error('저장할 키·노브를 1~72개 선택하세요.');
  const seen=new Set();
  return entries.map(e=>{
    if(!e||typeof e!=='object'||![1,2,3].includes(e.layer)||!controls.includes(e.control))throw new Error('레이어 또는 키·노브 선택이 올바르지 않습니다.');
    const id=controls.indexOf(e.control)+1,key=e.layer+':'+id;
    if(seen.has(key))throw new Error('같은 레이어의 키·노브가 중복되었습니다.');seen.add(key);
    return {layer:e.layer,control:e.control,id,action:e.action};
  }).sort((a,b)=>a.layer-b.layer||a.id-b.id);
}
function chord(keys){
  if(!Array.isArray(keys)||!keys.length)throw new Error('단축키의 일반 키를 지정하세요.');
  let mods=0,usage=null;
  for(const raw of keys){
    let name=raw===' '?'SPACE':String(raw).trim().toUpperCase();
    if(/^KEY[A-Z]$/.test(name))name=name.slice(3);
    if(/^DIGIT[0-9]$/.test(name))name=name.slice(5);
    name=aliases[name]||name;
    if(modifiers[name]){mods|=modifiers[name];continue;}
    if(usages[name]===undefined)throw new Error(`기기 저장을 지원하지 않는 키: ${raw}`);
    if(usage!==null)throw new Error('기기 단축키는 Ctrl/Shift/Alt/Win 조합과 일반 키 1개만 지원합니다.');
    usage=usages[name];
  }
  if(usage===null)throw new Error('보조 키만 누르는 동작은 앱 모드를 사용하세요.');
  // These usages are reserved by the bridge. Reject even within a sequence:
  // a direct firmware chord must never dispatch another app-owned slot.
  if(usage>=0x68&&usage<=0x73)throw new Error('F13~F24는 앱 연결 신호로 예약되어 있어 기기 직접 저장에서 사용할 수 없습니다.');
  return [mods,usage];
}
function assertPortableOptions(a){
  if(a.disabled)throw new Error('비활성화된 동작은 기기에 저장할 수 없습니다.');
  if(a.delayMs||a.jitterMs||a.intervalMs||a.repeatCount>1||a.count>1||a.repeatMode==='toggle'||(a.playbackSpeed!==undefined&&a.playbackSpeed!==1))throw new Error('지연·속도·반복은 앱에서 실행하세요. 기기 저장은 기본 입력만 지원합니다.');
}
function keyboardStrokes(a){
  assertPortableOptions(a);
  if(a.type==='shortcut')return [chord(a.keys)];
  if(a.type==='sequence'){
    if(!a.steps?.length)throw new Error('빈 매크로는 기기에 저장할 수 없습니다.');
    const values=a.steps.flatMap(keyboardStrokes);
    if(values.length>18)throw new Error('기기 키보드 연속 입력은 최대 18개 단축키입니다.');
    return values;
  }
  throw new Error('키보드 연속 입력에는 지연 없는 단축키만 넣을 수 있습니다.');
}
function compileAction(action,id,layer){
  const a=validateAction(action);assertPortableOptions(a);
  const base=[3,0xfe,id,layer];
  if(a.type==='none')return {kind:'none',summary:'입력 없음',action:a,report:[...packet([...base,1,0,0,0,0,0,0])]};
  if(a.type==='shortcut'||a.type==='sequence'){
    const strokes=keyboardStrokes(a);
    const summary=strokes.map(([mods,usage])=>[...modifierNames.filter((_,i)=>mods&(1<<i)),usageNames[usage]].join('+')).join(' → ');
    return {kind:strokes.length===1?'keyboard':'sequence',summary,action:a,report:[...packet([...base,1,0,0,0,0,0,strokes.length,...strokes.flat()])]};
  }
  if(a.type==='media'){
    const code=mediaUsages[a.media];if(code===undefined)throw new Error('지원하지 않는 미디어 키입니다.');
    return {kind:'media',summary:a.media,action:a,report:[...packet([...base,2,0,0,0,0,0,0,code&255,code>>8])]};
  }
  if(a.type==='page'||a.type==='profile')throw new Error('PC 페이지 전환은 MONO DECK이 실행합니다. 키보드 메모리에 직접 저장할 수 없습니다.');
  if(a.type==='app')throw new Error('프로그램 경로를 실행하는 액션은 PC 전용입니다. 탐색기를 기기에 저장하려면 단축키 Win+E를 지정하세요.');
  throw new Error('기기 저장은 단축키·미디어·최대 18개 키보드 연속 입력만 지원합니다. 텍스트·좌표·녹화·조건·키 누름/뗌은 앱 모드를 사용하세요.');
}
function planOnboard(input){
  const entries=[],incompatible=[];
  for(const e of selection(input)){
    try{entries.push({...e,...compileAction(e.action,e.id,e.layer)});}
    catch(error){incompatible.push({layer:e.layer,control:e.control,reason:error.message});}
  }
  const hash=createHash('sha256').update(JSON.stringify(entries.map(e=>e.report))).digest('hex');
  return {ok:incompatible.length===0,entries,incompatible,warnings:[...warnings],hash};
}
function isAppManaged(r){return Buffer.from(r).subarray(2).equals(mappingPacket(r[2],r[3]).subarray(2));}
function editable(result,action){
  // Unknown header/tail bytes are not silently discarded by an edit/import.
  const rebuilt=compileAction(action,result.id,result.layer).report;
  if(!Buffer.from(result.raw).subarray(2).equals(Buffer.from(rebuilt).subarray(2)))return {...result,summary:result.summary+' · 추가 원본 데이터 있음',editable:false};
  return {...result,action,editable:true};
}
function decodeRecord(r){
  const result={layer:r[3],control:controls[r[2]-1],id:r[2],type:r[4],kind:'unknown',summary:`지원하지 않는 기기 형식 ${r[4]}`,raw:[...r],appManaged:isAppManaged(r),timingKnown:false,editable:false};
  if(result.appManaged)return {...result,kind:'app',summary:'MONO DECK 앱 연결 신호'};
  if(r[4]===1){
    const count=r[10];if(count>18)return {...result,summary:`해석하지 않은 키보드 항목 ${count}개`};
    if(count===0){
      if(r[11]||r[12])return {...result,kind:'modifier',summary:'보조 키 전용 입력 (원본 보존)'};
      return editable({...result,kind:'none',summary:'입력 없음'},{type:'none'});
    }
    const strokes=Array.from({length:count},(_,i)=>[r[11+2*i],r[12+2*i]]);
    const steps=strokes.map(([mods,usage])=>({type:'shortcut',keys:[...modifierNames.filter((_,i)=>mods&(1<<i)),usageNames[usage]||`HID_0x${usage.toString(16).padStart(2,'0')}`]}));
    const action=steps.length===1?steps[0]:{type:'sequence',steps};
    const supported=strokes.every(([,usage])=>!!usageNames[usage]&&usage<0x68);
    const decoded={...result,kind:count===1?'keyboard':'sequence',summary:steps.map(s=>s.keys.join('+')).join(' → '),strokes};
    return supported?editable(decoded,action):decoded;
  }
  if(r[4]===2){const code=r[11]|(r[12]<<8),media=mediaNames[code],decoded={...result,kind:'media',summary:media||`미디어 HID 0x${code.toString(16)}`,usage:code};return media?editable(decoded,{type:'media',media}):decoded;}
  if(r[4]===3){
    const signed=x=>x>127?x-256:x;
    const subtype=r[10],details={subtype,modifiers:r[11],buttons:r[12]};
    if(subtype===5)Object.assign(details,{dx:signed(r[13]),dy:signed(r[14])});
    if(subtype===3)details.wheel=signed(r[15]);
    return {...result,kind:'mouse',summary:subtype===1?`마우스 버튼 ${r[12]}`:subtype===5?`상대 이동 ${details.dx}, ${details.dy}`:subtype===3?`마우스 휠 ${details.wheel}`:'마우스 원본 (해석 범위 밖)',details};
  }
  return result;
}
function decodeReports(reports,layers=[1,2,3]){validateReports(reports,layers);return reports.map(decodeRecord);}
module.exports={planOnboard,compileAction,decodeReports,selection,isAppManaged,mediaUsages};
