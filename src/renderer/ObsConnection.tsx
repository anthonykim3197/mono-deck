import {Check,Radio} from 'lucide-react';
import type {DeckAPI,ObsInventory,ObsTargets} from './types';
export default function ObsConnection({api,busy,perform,inventory,setInventory,targets,setTargets,setMessage}:{api?:DeckAPI;busy:string;perform:(name:string,job:()=>Promise<void>)=>Promise<void>;inventory:ObsInventory|null;setInventory:(v:ObsInventory)=>void;targets:ObsTargets;setTargets:(v:ObsTargets)=>void;setMessage:(v:string)=>void}){
  const options=(value:string)=><><option value="">연결 안 함</option>{value&&!inventory?.audio.some(a=>a.inputName===value)&&<option value={value}>{value} · 현재 없음</option>}{inventory?.audio.map(a=><option value={a.inputName} key={a.inputName}>{a.inputName}</option>)}</>;
  return <>
    <h3><Radio size={20}/> OBS 장면 · 오디오 믹서</h3>
    <p>OBS → 도구 → WebSocket 서버 설정에서 서버를 활성화한 뒤 연결하세요. 이 PC의 OBS 설정을 사용하며 비밀번호는 프리셋에 넣지 않습니다.</p>
    <button className="secondary-button" disabled={!!busy||!api} onClick={()=>perform('obs',async()=>{const result=await api!.inspectObs();setInventory(result);setTargets(result.targets);setMessage('OBS 소스 목록을 읽었습니다. 키에 연결할 오디오를 선택하세요.');})}><Radio size={16}/> OBS 연결 확인 · 소스 읽기</button>
    <div className="obs-mixer-guide"><strong>교회 오디오 믹서 · 키로 선택 → 큰 노브로 조절</strong><p>예: 키 1 = HDMI 캡처, 키 2 = 믹서 USB 입력, 키 3 = 송출 PC 오디오. 실제 OBS 소스 이름으로 연결합니다. 선택만으로 소리 크기가 바뀌지는 않습니다.</p><span>큰 노브 ±0.5 dB · 클릭 음소거 / 왼쪽 작은 노브 소스 이동 · 클릭 상태 표시 / 오른쪽 위 노브 공통 페이지 이동</span></div>
    <h3>오디오 선택 키 1~15</h3>
    <p>필요한 키만 연결하세요. OBS에 합쳐서 들어오는 입력은 하나로 조절됩니다. 하드웨어 믹서의 개별 채널·게인은 변경하지 않습니다.</p>
    <div className="obs-source-slots">{Array.from({length:15},(_,i)=>{const value=targets.sources?.[i]||'';return <label key={i}><span>키 {String(i+1).padStart(2,'0')}</span><select className="text-input" aria-label={`오디오 선택 키 ${i+1}`} disabled={!!busy||!inventory} value={value} onChange={e=>{const sources=Array.from({length:15},(_,n)=>targets.sources?.[n]||'');sources[i]=e.target.value;setTargets({...targets,sources});}}>{options(value)}</select></label>;})}</div>
    {inventory&&<><h3>기존 OBS 페이지 · 고정 오디오</h3><div className="preset-obs-grid">{(['volume','microphone'] as const).map(role=><label key={role}>{role==='volume'?'고정 캡처 소스':'고정 마이크 소스'}<select className="text-input" disabled={!!busy} value={targets[role]||''} onChange={e=>setTargets({...targets,[role]:e.target.value})}>{options(targets[role]||'')}</select></label>)}</div><button className="primary-button" disabled={!!busy} onClick={()=>perform('obs-save',async()=>{setTargets(await api!.saveObsTargets(targets));setMessage('오디오 연결을 이 PC에 저장했습니다. 오디오 믹서 페이지에서 소스 키를 누르고 노브를 돌리세요.');})}><Check size={16}/> 오디오 연결 저장</button><h3 className="obs-scenes-heading">OBS 장면 순서</h3><ol className="preset-scene-list">{inventory.scenes.map(s=><li key={s.sceneName}>{s.sceneName}{s.sceneName===inventory.currentScene?' · 현재 송출':''}</li>)}</ol></>}
  </>;
}
