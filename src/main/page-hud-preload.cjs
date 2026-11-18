const {ipcRenderer}=require('electron');
let latest;
function render(state){
  if(!document.getElementById('title'))return;
  if(state.kind==='obs'){for(const id of ['title','detail','mode'])document.getElementById(id).textContent=state[id]||'';return;}
  const id=state.candidateId||state.activeId,index=state.pages.findIndex(p=>p.id===id);
  const zero=id==='@onboard',t=state.transition;
  document.getElementById('title').textContent=t?`그룹 ${t.layer} → ${t.targetMode==='onboard'?'온보드 0':'PC 모드'}`:zero?'00 · 기기 프리셋 (PC)':`${String(index+1).padStart(2,'0')} · ${state.pages[index]?.name||''}`;
  document.getElementById('mode').textContent=t?'기기 메모리 기록 중':state.candidateId?'페이지 선택 중 · 노브를 눌러 확정':`마지막 확인된 기기 그룹 ${state.layer||'미확인'}`;
  document.getElementById('detail').textContent=t?`${({preparing:'매크로 중지',reading:'원본 읽기·백업',writing:'기기에 기록',verifying:'저장 결과 검증'})[t.phase]||t.phase} · ${t.done}/${t.total} · USB 연결 유지`:state.candidateId?'회전: 0~전체 페이지 · 클릭: 확정':'Ctrl+Alt+0~9 즉시 전환 · 10번 이후는 노브';
}
ipcRenderer.on('page-state',(_event,state)=>{latest=state;render(state);});
window.addEventListener('DOMContentLoaded',()=>{if(latest)render(latest);});
