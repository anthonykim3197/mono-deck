import {useEffect,useRef,useState} from 'react';
import {ArrowUpFromLine,Check,Keyboard,Loader2,Plus,Save,Trash2,X} from 'lucide-react';
import type {Action,DeckAPI,OnboardRow} from './types';

const media=[['volumeUp','음량 높이기'],['volumeDown','음량 낮추기'],['mute','음소거'],['playPause','재생 / 일시정지'],['next','다음 트랙'],['previous','이전 트랙'],['stop','재생 중지']];
const label=(id:string)=>id.startsWith('key')?`키 ${id.slice(3).padStart(2,'0')}`:`노브 ${id[4]} · ${{ccw:'왼쪽',cw:'오른쪽',press:'클릭'}[id.split('.')[1]]}`;
const parse=(value:string)=>{const plus=/\+\s*\+$/.test(value);return [...value.split('+').map(v=>v.trim().toUpperCase()).filter(Boolean),...(plus?['+']:[])];};
export default function OnboardZeroView({api,layer,savedAt,connected,hardwareMode,onBusyChange}:{api?:DeckAPI;layer:number;savedAt?:string;connected:boolean;hardwareMode?:string;onBusyChange?:(value:string)=>void}){
  const [rows,setRows]=useState<OnboardRow[]>([]),[hash,setHash]=useState('');
  const [selected,setSelected]=useState('key1'),[type,setType]=useState('none'),[chords,setChords]=useState<string[]>(['']),[mediaKey,setMediaKey]=useState('volumeUp');
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[review,setReview]=useState<'upload'|'import'|null>(null);
  const epoch=useRef(0);
  const load=async()=>{const token=++epoch.current;const result=await api?.readOnboardBank?.(layer);if(result&&token===epoch.current){setRows(result.entries);setHash(result.hash);}};
  useEffect(()=>{setRows([]);setHash('');setError('');setNotice('');setReview(null);if(connected&&savedAt)void load().catch(e=>setError(String(e)));return()=>{epoch.current++;};},[api,layer,savedAt,connected]);
  const row=rows.find(r=>r.control===selected),reserved=!!row?.appManaged;
  useEffect(()=>{const a=row?.action;setType(a?.type||'none');setChords(a?.type==='sequence'?(a.steps||[]).map(s=>(s.keys||[]).join('+')):[(a?.keys||[]).join('+')]);setMediaKey(a?.media||'volumeUp');setReview(null);},[row]);
  const job=async(name:string,fn:()=>Promise<void>)=>{if(busy)return;setBusy(name);onBusyChange?.(`zero-${name}`);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy('');onBusyChange?.('');}};
  const save=()=>job('save',async()=>{
    if(!api?.saveZeroPreset||!api.planOnboard)throw new Error('앱 연결을 확인하세요.');
    const action:Action={type,label:'',...(type==='shortcut'?{keys:parse(chords[0]||'')}:type==='sequence'?{steps:chords.map(keys=>({type:'shortcut',keys:parse(keys),label:''}))}:type==='media'?{media:mediaKey}:{})};
    const entries=[{layer,control:selected,action}],plan=await api.planOnboard(entries);
    if(!plan.ok)throw new Error(plan.incompatible.map(e=>e.reason).join(' '));
    const result=await api.saveZeroPreset(entries,{expectedHash:plan.hash});await load();setNotice(result.message);
  });
  const tile=(r:OnboardRow)=><button className={selected===r.control?'selected':''} disabled={!!busy} key={r.control} onClick={()=>setSelected(r.control)}><span>{label(r.control)}</span><strong>{r.appManaged?({ccw:'이전 페이지 후보',cw:'다음 페이지 후보',press:'페이지 선택 확정'})[r.control.split('.')[1]]:['empty','none'].includes(r.kind)?'비어 있음':r.summary}</strong></button>;
  return <section className="control-card zero-view"><div className="control-card-header"><div><span className="panel-kicker">PORTABLE PRESET · PC COPY</span><h2><Keyboard size={22}/> 0번 프리셋 · 그룹 {layer} 편집</h2></div><span className="tag">페이지 이동은 즉시</span></div>
    <p>기기에서 가져온 구성을 PC에서 실행합니다. 저장 가능한 동작만 편집하며, 실제 기기에 쓰기는 아래 버튼으로 따로 실행합니다.</p>
    <div className="zero-key-grid">{rows.filter(r=>r.control.startsWith('key')).map(tile)}</div>
    <div className="zero-knob-list">{rows.filter(r=>r.control.startsWith('knob')).map(tile)}</div>
    {error&&<p className="error-text" role="alert">{error}</p>}{notice&&<p className="zero-notice" role="status"><Check size={16}/>{notice}</p>}
    <div className="zero-editor"><div className="zero-editor-heading"><h3>{label(selected)}</h3><span>단축키 · 미디어 · 키 조합 18개까지</span></div>
      {reserved?<p>이 노브는 모든 그룹·페이지의 공통 전환용입니다. 기기에 저장해도 페이지 선택 기능은 MONO DECK이 실행합니다.</p>:<>
        {row&&!row.editable&&<p className="error-text">해석할 수 없는 원본 설정입니다. PC에서는 실행하지 않습니다. 아래에서 새 동작을 저장하면 이 슬롯의 원본을 교체합니다.</p>}
        <label className="field-label" htmlFor="zero-action-type">0번 동작 종류</label><select id="zero-action-type" disabled={!!busy||!row} value={type} onChange={e=>{setType(e.target.value);setChords([chords[0]||'']);}}><option value="none">비워두기</option><option value="shortcut">단축키</option><option value="media">미디어</option><option value="sequence">키보드 연속 입력 · 최대 18개</option></select>
        {(type==='shortcut'||type==='sequence')&&<div className="zero-chords">{chords.map((value,i)=><div key={i}><span>{i+1}</span><input aria-label={`0번 키 조합 ${i+1}`} placeholder="예: CTRL+C, SHIFT+WIN+S" disabled={!!busy} value={value} onChange={e=>setChords(previous=>previous.map((v,n)=>n===i?e.target.value:v))}/>{type==='sequence'&&<button className="icon-button" title={`${i+1}번 조합 삭제`} disabled={!!busy||chords.length===1} onClick={()=>setChords(previous=>previous.filter((_,n)=>n!==i))}><Trash2 size={16}/></button>}</div>)}{type==='sequence'&&<button className="secondary-button" disabled={!!busy||chords.length>=18} onClick={()=>setChords(previous=>[...previous,''])}><Plus size={15}/> 키 조합 추가 ({chords.length}/18)</button>}</div>}
        {type==='media'&&<select aria-label="0번 미디어 동작" disabled={!!busy} value={mediaKey} onChange={e=>setMediaKey(e.target.value)}>{media.map(([v,n])=><option value={v} key={v}>{n}</option>)}</select>}
        <p className="zero-limits">프로그램 실행·마우스 좌표·텍스트·지연·반복·조건과 19개 이상 키 조합은 PC 페이지 1번 이후에서 사용하세요. 기기에서 읽히지 않는 기존 지연값은 재현하지 않습니다.</p>
        <button className="primary-button" disabled={!!busy||!row||!api?.saveZeroPreset} onClick={save}>{busy==='save'?<Loader2 size={16} className="spin"/>:<Save size={16}/>} 0번 프리셋에 저장 · PC 보관</button>
      </>}
    </div>
    <div className="zero-device-actions"><div><strong>다른 PC에서 앱 없이 사용하기</strong><p>그룹 {layer}의 0번 보관본 전체를 기기에 기록합니다. 페이지 선택과는 별개이며 약 4초가 걸립니다.</p></div><button className="secondary-button" disabled={!!busy||!connected||!hash} onClick={()=>setReview('upload')}><ArrowUpFromLine size={16}/> 기기에 쓰기 검토</button><button className="secondary-button" disabled={!!busy||!connected} onClick={()=>setReview('import')}>기기에서 0번 가져오기</button></div>
    {review&&<div className="zero-write-review"><strong>{review==='upload'?`기기 그룹 ${layer}에 0번 프리셋 전체를 기록합니다`:`기기 그룹 ${layer}의 직접 입력을 0번에 가져옵니다`}</strong><p>{review==='upload'?'위에 표시된 저장본을 기록합니다. 편집 중인 미저장 내용은 포함되지 않습니다. 기록 후 이 그룹은 기기 자체에서 직접 입력을 보내며, PC 페이지를 사용하려면 PC 연결 준비가 필요합니다.':'해당 슬롯의 PC 보관본을 기기에서 읽은 설정으로 교체합니다. 앱 연결 신호인 슬롯은 기존 0번 내용을 유지합니다.'}</p><div><button className="primary-button" disabled={!!busy} onClick={()=>job(review,async()=>{const result=review==='upload'?await api!.applyZeroPreset!(layer,hash):await api!.importZeroPreset!(layer);setReview(null);await load();setNotice(result.message);})}>{busy?<Loader2 size={16} className="spin"/>:<Check size={16}/>} {review==='upload'?`그룹 ${layer} 기기에 기록`:'가져오기 실행'}</button><button className="secondary-button" disabled={!!busy} onClick={()=>setReview(null)}><X size={16}/> 취소</button></div></div>}
    <small>편집 그룹 {layer} · {hardwareMode==='pc'?'기기 PC 연결 준비됨':hardwareMode==='onboard'?'기기 직접 입력 상태':'기기 PC 연결 준비 필요'}. 앱 시작 시 내장 설정을 보관하며, 이미 앱 신호로 연결된 기기는 기존 보관본을 사용합니다.</small>
  </section>;
}
