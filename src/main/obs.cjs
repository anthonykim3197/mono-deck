const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const hash=text=>createHash('sha256').update(text).digest('base64');
const authentication=(password,salt,challenge)=>hash(hash(password+salt)+challenge);
class ObsClient{
  constructor({getConnection,WebSocketImpl=globalThis.WebSocket,timeout=4000}){Object.assign(this,{getConnection,WebSocketImpl,timeout});this.pending=new Map();this.socket=null;this.connected=false;this.connecting=null;}
  disconnect(){this.connected=false;const socket=this.socket;this.socket=null;socket?.close();for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('OBS 연결이 종료되었습니다.'));}this.pending.clear();}
  async connect(){
    if(this.connected)return;if(this.connecting)return this.connecting;
    this.connecting=this.open();try{await this.connecting;}finally{this.connecting=null;}
  }
  open(){return new Promise((resolve,reject)=>{
    let settings;try{settings=this.getConnection();}catch(e){reject(e);return;}
    const socket=new this.WebSocketImpl(`ws://127.0.0.1:${settings.port}`);this.socket=socket;let settled=false;
    const fail=message=>{if(this.socket!==socket)return;this.disconnect();if(!settled){settled=true;clearTimeout(timer);reject(new Error(message));}};
    const timer=setTimeout(()=>fail('OBS 연결 시간이 초과되었습니다. OBS 실행과 WebSocket 설정을 확인하세요.'),this.timeout);
    socket.addEventListener('error',()=>fail('OBS에 연결할 수 없습니다. OBS 실행과 WebSocket 서버 활성화를 확인하세요.'));
    socket.addEventListener('close',event=>fail(event.code===4009?'OBS 인증 실패: OBS의 현재 연결 설정을 확인하세요.':'OBS 연결이 끊겼습니다.'));
    socket.addEventListener('message',event=>{
      if(this.socket!==socket)return;
      let message;try{message=JSON.parse(event.data);}catch{fail('OBS 응답 형식이 올바르지 않습니다.');return;}
      if(message.op===0){const d={rpcVersion:1,eventSubscriptions:0};if(message.d.authentication)d.authentication=authentication(settings.password||'',message.d.authentication.salt,message.d.authentication.challenge);socket.send(JSON.stringify({op:1,d}));}
      else if(message.op===2){clearTimeout(timer);settled=true;this.connected=true;resolve();}
      else if(message.op===7){const d=message.d,request=this.pending.get(d.requestId);if(!request)return;clearTimeout(request.timer);this.pending.delete(d.requestId);if(d.requestStatus.result)request.resolve(d.responseData||{});else request.reject(new Error(`OBS ${request.type}: ${d.requestStatus.comment||d.requestStatus.code}`));}
    });
  });}
  async request(type,data={}){
    await this.connect();return new Promise((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`OBS 응답 시간 초과: ${type}`));},this.timeout);this.pending.set(id,{resolve,reject,timer,type});try{this.socket.send(JSON.stringify({op:6,d:{requestType:type,requestId:id,requestData:data}}));}catch{clearTimeout(timer);this.pending.delete(id);reject(new Error('OBS 요청을 전송하지 못했습니다.'));}});
  }
}
class ObsController{
  constructor({client,getTargets=()=>({}),onFeedback=()=>{},now=()=>Date.now()}){Object.assign(this,{client,getTargets,onFeedback,now});this.candidate=null;this.selectedAudio=null;}
  feedback(title,detail){this.onFeedback({kind:'obs',title,detail,mode:'OBS 직접 제어'});return {ok:true,message:`${title} · ${detail}`};}
  async scenes(){const r=await this.client.request('GetSceneList');return {...r,scenes:r.scenes.slice().sort((a,b)=>a.sceneIndex-b.sceneIndex)};}
  async inspect(){
    const list=await this.scenes(),inputs=await this.client.request('GetInputList'),special=await this.client.request('GetSpecialInputs');
    const unique=new Map(inputs.inputs.map(input=>[input.inputName,input]));
    for(const name of Object.values(special))if(typeof name==='string'&&name&&!unique.has(name))unique.set(name,{inputName:name,inputKind:'global_audio'});
    const audio=[];for(const input of unique.values()){try{const v=await this.client.request('GetInputVolume',{inputName:input.inputName});audio.push({...input,inputVolumeDb:v.inputVolumeDb});}catch{}}
    return {connected:true,scenes:list.scenes,currentScene:list.currentProgramSceneName,audio,targets:this.getTargets(),selectedAudio:this.selectedName()};
  }
  selectedName(){const chosen=this.selectedAudio;if(!chosen)return '';if(this.getTargets().sources?.[chosen.index]!==chosen.name){this.selectedAudio=null;return '';}return chosen.name;}
  async audioRead(inputName){const v=await this.client.request('GetInputVolume',{inputName}),m=await this.client.request('GetInputMute',{inputName});if(!Number.isFinite(v.inputVolumeDb))throw new Error('OBS 볼륨 값을 읽을 수 없습니다.');return {db:v.inputVolumeDb,muted:!!m.inputMuted};}
  audioFeedback(inputName,state,detail){return this.feedback(`${inputName} · ${state.db.toFixed(1)} dB${state.muted?' · 음소거':''}`,detail);}
  async execute(a,guard=()=>{}){
    const op=a.obsOperation;
    if(op.startsWith('source')){
      const sources=this.getTargets().sources||[],available=sources.map((name,index)=>({name,index})).filter(s=>s.name);
      let chosen=this.selectedAudio;this.selectedName();chosen=this.selectedAudio;
      if(op==='sourceSelect')chosen={index:a.audioIndex,name:sources[a.audioIndex]};
      else if(op==='sourcePrevious'||op==='sourceNext'){
        const index=available.findIndex(s=>s.index===chosen?.index);
        chosen=available[index<0?(op==='sourceNext'?0:available.length-1):(index+(op==='sourceNext'?1:-1)+available.length)%available.length];
      }
      if(!chosen?.name){this.selectedAudio=null;throw new Error('조절할 오디오 소스를 선택하세요. 프리셋 라이브러리 → OBS 연결에서 키 1~15에 소스를 연결할 수 있습니다.');}
      let state;try{state=await this.audioRead(chosen.name);guard();}catch(e){this.selectedAudio=null;throw e;}
      this.selectedAudio=chosen;return this.audioFeedback(chosen.name,state,`오디오 ${String(chosen.index+1).padStart(2,'0')} 선택 · 큰 노브로 볼륨 조절 · 클릭 음소거`);
    }
    if(op.startsWith('scene')){
      const list=await this.scenes();guard();if(!list.scenes.length)throw new Error('OBS 장면이 없습니다.');
      const candidate=this.candidate&&this.now()-this.candidate.at<8000&&list.scenes.find(s=>s.sceneName===this.candidate.name&&(!this.candidate.uuid||s.sceneUuid===this.candidate.uuid));
      if(op==='sceneNext'||op==='scenePrevious'){
        const current=candidate?.sceneName||list.currentProgramSceneName,index=list.scenes.findIndex(s=>s.sceneName===current);
        const selected=list.scenes[(Math.max(index,0)+(op==='sceneNext'?1:-1)+list.scenes.length)%list.scenes.length];
        this.candidate={name:selected.sceneName,uuid:selected.sceneUuid,at:this.now()};return this.feedback(selected.sceneName,'장면 선택 중 · 왼쪽 작은 노브 클릭으로 송출 화면 확정');
      }
      const scene=op==='sceneConfirm'?candidate:list.scenes[a.sceneIndex];if(!scene)throw new Error(op==='sceneConfirm'?'장면 후보가 없거나 만료됐습니다. 노브를 다시 돌려주세요.':'해당 번호의 OBS 장면이 없습니다.');
      guard();await this.client.request('SetCurrentProgramScene',{sceneName:scene.sceneName});this.candidate=null;return this.feedback(scene.sceneName,'송출 장면 전환 완료');
    }
    if(['volumeUp','volumeDown','mute','unmute','toggleMute'].includes(op)){
      const role=a.inputRole||'volume',inputName=role==='selected'?this.selectedName():this.getTargets()[role];if(!inputName)throw new Error(role==='selected'?'먼저 오디오 선택 키를 누르거나 왼쪽 작은 노브로 소스를 선택하세요.':'프리셋 라이브러리 → OBS 연결에서 오디오 대상을 먼저 선택하세요.');
      if(op.startsWith('volume')){
        let old;try{old=await this.audioRead(inputName);}catch(e){if(role==='selected')this.selectedAudio=null;throw e;}guard();
        const db=Math.round(Math.max(-100,Math.min(0,old.db+(op==='volumeUp'?1:-1)*(a.volumeStepDb||1)))*10)/10;
        await this.client.request('SetInputVolume',{inputName,inputVolumeDb:db});return this.audioFeedback(inputName,{db,muted:old.muted},`OBS 소스 볼륨 · ${a.volumeStepDb||1} dB씩 · 최대 0 dB`);
      }
      guard();const result=op==='toggleMute'?await this.client.request('ToggleInputMute',{inputName}):await this.client.request('SetInputMute',{inputName,inputMuted:op==='mute'});return this.feedback(inputName,(op==='mute'||op==='toggleMute'&&result.inputMuted)?'음소거':'소리 켜짐');
    }
    if(op==='studioToggle'){const old=await this.client.request('GetStudioModeEnabled');guard();await this.client.request('SetStudioModeEnabled',{studioModeEnabled:!old.studioModeEnabled});return this.feedback('스튜디오 모드',old.studioModeEnabled?'꺼짐':'켜짐');}
    const request={startRecord:'StartRecord',stopRecord:'StopRecord',pauseRecord:'PauseRecord',resumeRecord:'ResumeRecord',saveReplay:'SaveReplayBuffer'}[op];
    if(!request)throw new Error('지원하지 않는 OBS 동작입니다.');guard();await this.client.request(request);return this.feedback(a.label||request,'OBS 요청 완료');
  }
}
function localConnection(appData){
  let c;try{c=JSON.parse(fs.readFileSync(path.join(appData,'obs-studio/plugin_config/obs-websocket/config.json'),'utf8'));}catch{throw new Error('OBS WebSocket 5 설정을 찾지 못했습니다. OBS → 도구 → WebSocket 서버 설정을 확인하세요.');}
  if(!c.server_enabled)throw new Error('OBS의 WebSocket 서버가 꺼져 있습니다. OBS → 도구 → WebSocket 서버 설정에서 활성화한 뒤 다시 연결하세요.');
  const port=Number(c.server_port);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('OBS WebSocket 포트가 잘못되었습니다.');
  return {port,password:c.server_password||''};
}
function validateTargets(input,audio){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('OBS 오디오 설정이 잘못되었습니다.');
  const name=value=>{if(value===undefined)return '';if(typeof value!=='string'||value&&!audio.some(a=>a.inputName===value))throw new Error('OBS에서 확인된 오디오 소스를 선택하세요.');return value;};
  if(input.sources!==undefined&&(!Array.isArray(input.sources)||input.sources.length>15))throw new Error('오디오 선택 키는 최대 15개입니다.');
  return {volume:name(input.volume),microphone:name(input.microphone),sources:Array.from({length:15},(_,i)=>name(input.sources?.[i]))};
}
module.exports={ObsClient,ObsController,localConnection,authentication,validateTargets};
