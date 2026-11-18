const target=document.getElementById('target'),start=document.getElementById('start'),status=document.getElementById('status'),result=document.getElementById('result');
let active=false,observed={};
target.addEventListener('mousemove',e=>{if(active&&e.isTrusted)observed.moved=true;});
target.addEventListener('mousedown',e=>{if(active&&e.isTrusted){observed.clicked=true;observed.clickedAt=performance.now();}});
target.addEventListener('keydown',e=>{if(!active||!e.isTrusted)return;if(observed.keyAt===undefined)observed.keyAt=performance.now();if(e.ctrlKey&&e.key.toLowerCase()==='a')observed.ctrlA=true;if(e.key==='F8')observed.f8Down=true;});
target.addEventListener('keyup',e=>{if(active&&e.isTrusted&&e.key==='F8')observed.f8Up=true;});
start.addEventListener('click',async()=>{
  start.disabled=true;active=true;observed={};target.value='이 문장이 전체 선택된 뒤 테스트 문장으로 바뀝니다.';status.className='status';status.textContent='실제 입력을 보내는 중…';
  try{
    const rect=target.getBoundingClientRect();const run=await window.testpad.start({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
    await new Promise(resolve=>setTimeout(resolve,100));active=false;
    if(!run.id)throw new Error(run.error||'테스트가 취소되었습니다.');
    const checked=await window.testpad.finish({id:run.id,...observed,value:target.value,delayMs:observed.keyAt-observed.clickedAt});
    status.textContent=checked.ok?'모든 단계 성공':'테스트 중지 / 결과 확인';status.className='status '+(checked.ok?'pass':'fail');
    result.textContent=[`물리 화면 좌표: (${run.point.x}, ${run.point.y})`,`마우스 이동 ${observed.moved?'✓':'✗'} · 클릭 ${observed.clicked?'✓':'✗'}`,`클릭 → 첫 키: ${Math.round(observed.keyAt-observed.clickedAt)} ms (설정 500 ms)`,`Ctrl+A ${observed.ctrlA?'✓':'✗'} · F8 누름 ${observed.f8Down?'✓':'✗'} / 뗌 ${observed.f8Up?'✓':'✗'}`,`텍스트 일치: ${target.value===run.expected?'✓':'✗'}`,run.error||`결과 저장: ${checked.path}`].join('\n');
  }catch(e){status.textContent='테스트 실패';status.className='status fail';result.textContent=e.message;}
  finally{active=false;start.disabled=false;}
});
document.getElementById('close').addEventListener('click',()=>window.testpad.close());
