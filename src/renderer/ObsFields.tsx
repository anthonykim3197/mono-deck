import type {Action} from './types';
export const obsOperations=[['sourceSelect','오디오 선택 키 (1~15)'],['sourcePrevious','이전 오디오 소스 선택'],['sourceNext','다음 오디오 소스 선택'],['sourceStatus','선택한 오디오 상태 표시'],['scenePrevious','이전 장면 후보'],['sceneNext','다음 장면 후보'],['sceneConfirm','장면 후보 확정'],['sceneSelect','지정 순서의 장면'],['volumeDown','오디오 볼륨 내리기'],['volumeUp','오디오 볼륨 올리기'],['toggleMute','음소거 전환'],['mute','음소거'],['unmute','음소거 해제'],['startRecord','녹화 시작'],['pauseRecord','녹화 일시정지'],['resumeRecord','녹화 재개'],['stopRecord','녹화 종료'],['saveReplay','리플레이 저장'],['studioToggle','스튜디오 모드 전환']];
export default function ObsFields({action,onChange}:{action:Action;onChange:(patch:Partial<Action>)=>void}){
  const op=action.obsOperation||'sceneNext';
  return <div className="obs-action-fields">
    <label className="field-label">OBS 동작<select className="text-input" value={op} onChange={e=>onChange({obsOperation:e.target.value,...(e.target.value==='sceneSelect'?{sceneIndex:action.sceneIndex??0}:{}),...(e.target.value==='sourceSelect'?{audioIndex:action.audioIndex??0}:{})})}>{obsOperations.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
    {op==='sceneSelect'&&<label className="field-label">장면 목록 순서 (1부터)<input className="text-input" type="number" min={1} max={1000} value={(action.sceneIndex??0)+1} onChange={e=>onChange({sceneIndex:Number(e.target.value)-1})}/></label>}
    {op==='sourceSelect'&&<label className="field-label">연결한 오디오 선택 키<input className="text-input" type="number" min={1} max={15} value={(action.audioIndex??0)+1} onChange={e=>onChange({audioIndex:Number(e.target.value)-1})}/></label>}
    {['volumeUp','volumeDown','mute','unmute','toggleMute'].includes(op)&&<label className="field-label">오디오 대상<select className="text-input" value={action.inputRole||'volume'} onChange={e=>onChange({inputRole:e.target.value as Action['inputRole']})}><option value="selected">선택 키·노브로 고른 소스</option><option value="volume">고정 캡처 소스</option><option value="microphone">고정 마이크 소스</option></select></label>}
    {['volumeUp','volumeDown'].includes(op)&&<label className="field-label">한 칸 조절량<select className="text-input" value={action.volumeStepDb??1} onChange={e=>onChange({volumeStepDb:Number(e.target.value)})}>{[0.1,0.5,1,2].map(n=><option key={n} value={n}>{n} dB</option>)}</select></label>}
    <p className="field-description">프리셋 라이브러리 → OBS 연결에서 키 1~15에 실제 소스를 연결하세요. OBS 믹서 볼륨을 최대 0 dB까지 조절합니다.</p>
  </div>;
}
