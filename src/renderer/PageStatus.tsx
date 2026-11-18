import {Check, ChevronRight, Keyboard, Layers, Loader2, Monitor} from 'lucide-react';
import type {PageState,Profile} from './types';

export function ModeProgress({state}:{state:PageState|null}){
  const t=state?.transition;if(!t)return null;
  const labels:Record<string,string>={preparing:'실행 중인 매크로 정리',reading:'기기 설정 읽기 · 원본 백업',writing:'기기에 설정 기록',verifying:'기록된 설정과 나머지 그룹 검증'};
  const progress=t.phase==='verifying'?95:t.phase==='writing'?15+Math.round(75*t.done/Math.max(1,t.total)):t.phase==='reading'?8:2;
  return <div className="mode-progress-overlay" role="dialog" aria-modal="true" aria-label="기기 메모리 기록 중"><section>
    <Loader2 size={30} className="spin"/><span className="panel-kicker">기기 메모리 기록 중</span>
    <h2>그룹 {t.layer} <ChevronRight size={24}/> {t.targetMode==='onboard'?'온보드 0':'PC 모드'}</h2>
    <p>{labels[t.phase]||t.phase}{t.phase==='writing'?` · ${t.done} / ${t.total}개`:''}</p>
    <div className="mode-progress-track" role="progressbar" aria-label="기기 설정 전환 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{width:`${progress}%`}}/></div>
    <small>보통 약 4초가 걸립니다. 완료될 때까지 키·노브를 누르지 말고 USB 연결을 유지하세요.</small>
  </section></div>;
}

export default function PageStatus({state,profiles,profile,busy,navigate}:{state:PageState|null;profiles:Profile[];profile:Profile;busy:boolean;navigate:(operation:string,id?:string)=>void}){
  const zero=state?.mode==='onboard';
  const candidate=state?.candidateId;
  const label=(id:string)=>id==='@onboard'?'0 · 기기 프리셋':`${profiles.findIndex(p=>p.id===id)+1} · ${profiles.find(p=>p.id===id)?.name||''}`;
  const confirmed=state?.groupConfirmed&&state.layer;
  return <section className={`pc-page-bar runtime-page-bar ${zero?'onboard-active':''}`}>
    <div className="runtime-group"><span className="panel-kicker"><Layers size={13}/> 마지막 확인된 기기 그룹</span><strong>{confirmed?`그룹 ${state.layer}`:'확인 대기'}</strong><small>{confirmed?`${state.lastConfirmedAt?new Date(state.lastConfirmedAt).toLocaleTimeString('ko-KR',{hour12:false}):''} 입력 기준 · 실시간 조회 아님`:'전환 노브를 한 번 돌려 확인하세요.'}</small></div>
    <div className="runtime-current"><span className="panel-kicker">{zero?<Keyboard size={13}/>:<Monitor size={13}/>} {confirmed?'현재 페이지':'선택한 페이지'}</span><strong>{zero?'00 · 기기 프리셋 (PC 실행)':label(profile.id)}</strong><small>Ctrl+Alt+0~9 즉시 전환 · 10번 이후도 노브로</small></div>
    <div className="pc-page-buttons"><button className="secondary-button" disabled={busy} onClick={()=>navigate('onboard')}>0 프리셋</button><button className="secondary-button" disabled={busy} onClick={()=>navigate('previous')}>← 이전</button><button className="secondary-button" disabled={busy} onClick={()=>navigate('next')}>다음 →</button></div>
    {candidate&&<div className="page-candidate"><span>선택 후보 <b>{label(candidate)}</b> · 아직 전환되지 않았습니다</span><button className="primary-button" disabled={busy} onClick={()=>navigate('confirm')}><Check size={14}/> 확정</button><button className="secondary-button" disabled={busy} onClick={()=>navigate('cancel')}>취소</button></div>}
    {(confirmed&&state?.hardwareMode!=='pc')&&<p className="runtime-mode-note">이 그룹은 PC 연결 준비가 필요합니다. 페이지 선택은 기기 메모리를 바꾸지 않습니다. 아래 그룹을 맞추고 연결 버튼을 누르세요.</p>}
    {state?.error&&<p className="error-text runtime-mode-note">전환 확인 필요: {state.error}</p>}
    {!!state?.hotkeyFailures?.length&&<small className="error-text">단축키 등록 실패: {state.hotkeyFailures.join(', ')}</small>}
  </section>;
}
