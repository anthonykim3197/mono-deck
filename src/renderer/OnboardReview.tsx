import { ArrowUpFromLine, Check, CircleHelp, Loader2 } from 'lucide-react';
import type { OnboardPlan } from './types';

const controlLabel=(control:string)=>control.startsWith('key')?`키 ${control.slice(3).padStart(2,'0')}`:`노브 ${control[4]} · ${{ccw:'왼쪽',press:'누르기',cw:'오른쪽'}[control.split('.')[1]]||control}`;

export default function OnboardReview({plan,targetLayer,canExclude,canUpload,busy,onExclude,onUpload,onSavePreset}:{
  plan:OnboardPlan;targetLayer:number;canExclude:boolean;canUpload:boolean;busy:string;
  onExclude:()=>void;onUpload:()=>void;onSavePreset?:()=>void;
}) {
  const supported=plan.entries.length;
  const unsupported=plan.incompatible.length;
  const ready=plan.ok&&!unsupported&&supported>0;
  return <section className="onboard-review" aria-label="기기 저장 검토 결과">
    <div className="onboard-review-counts" role="status">
      <div className="supported"><Check size={20}/><span>기기 저장 가능 <strong>{supported}개</strong></span></div>
      {unsupported>0&&<div className="unsupported"><CircleHelp size={20}/><span>기기 저장에서 제외 필요 <strong>{unsupported}개</strong></span></div>}
    </div>
    {unsupported>0&&<div className="onboard-review-action">
      <p>{supported>0?`${supported}개는 정상적으로 저장할 수 있습니다. 아래 ${unsupported}개를 제외한 뒤 업로드하세요.`:'선택한 액션은 기기에 직접 저장할 수 없습니다. 아래 이유를 확인하세요.'}</p>
      {canExclude&&supported>0&&<button className="primary-button" disabled={!!busy} onClick={onExclude}>
        {busy==='plan'?<Loader2 size={16} className="spin"/>:<Check size={16}/>}
        불가능한 {unsupported}개 제외하고 저장 준비
      </button>}
      <small>제외한 항목은 기존 온보드 0 설정을 유지합니다. PC에 저장된 액션은 바뀌지 않습니다.</small>
    </div>}
    {ready&&<div className="onboard-review-action ready">
      <p><Check size={17}/> 그룹 {targetLayer}의 온보드 0에 {supported}개를 반영할 준비가 되었습니다.</p>
      {onSavePreset&&<button className="primary-button" disabled={!!busy} onClick={onSavePreset}><Check size={16}/> 0번 프리셋에만 저장 · 기기 기록 없음</button>}
      <button className="secondary-button" disabled={!!busy||!canUpload} onClick={onUpload}>
        {busy==='upload'?<Loader2 size={16} className="spin"/>:<ArrowUpFromLine size={16}/>}
        그룹 {targetLayer} · 0번 저장 후 기기에 기록 ({supported}개)
      </button>
      <small>기기에 기록할 때만 이 그룹이 직접 입력 상태로 바뀝니다. 제외한 항목의 기존 0번 설정과 공통 전환 노브는 유지합니다.</small>
    </div>}
    {supported>0&&<details className="onboard-plan valid" open={ready}>
      <summary className="onboard-plan-heading"><Check size={17}/><div><strong>저장 가능한 {supported}개 · 기록 내용 보기</strong><small className="onboard-supported-preview">{plan.entries.slice(0,3).map(entry=>entry.summary||entry.action.label||entry.action.type).join(' · ')}{supported>3?` 외 ${supported-3}개`:''}</small></div></summary>
      {plan.entries.map(entry=><div className="onboard-planned-row" key={`${entry.layer}-${entry.control}`}>
        <span>{controlLabel(entry.control)}</span><p>{entry.summary||entry.action.label||entry.action.type}</p><small><Check size={13}/> 저장 가능</small>
      </div>)}
    </details>}
    {unsupported>0&&<details className="onboard-plan invalid" open>
      <summary className="onboard-plan-heading"><CircleHelp size={17}/><strong>기기 저장에서 제외할 {unsupported}개 · 이유</strong></summary>
      {plan.incompatible.map(entry=><div className="onboard-incompatible" key={`${entry.layer}-${entry.control}`}>
        <strong>{controlLabel(entry.control)}</strong><p>{entry.reason}</p>
      </div>)}
    </details>}
    {plan.warnings?.length>0&&<details className="onboard-plan-warnings"><summary>기기 저장 안내</summary>{plan.warnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>}
  </section>;
}
