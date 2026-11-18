const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const {parsePack}=require('../src/main/presets.cjs');
const S=(label,...keys)=>({type:'shortcut',label,keys,icon:'command',color:'#b7a1ff'});
const T=(label,text)=>({type:'text',label,text,comment:'대상 앱의 입력창을 먼저 클릭하세요. 요청문만 입력하며 자동 전송하지 않습니다.',icon:'FileText',color:'#9bd9cf'});
const M=(label,delta)=>({type:'mouse',label,mouseAction:'scroll',delta,comment:'마우스 포인터를 스크롤할 답변·페이지 영역에 두세요.',icon:'MousePointer2',color:'#88b8ff'});
const Q=(label,steps)=>({type:'sequence',label,steps,repeatCount:1,icon:'zap',color:'#f1a684'});
const D=ms=>({type:'delay',label:`${ms}ms 대기`,delayMs:ms});
const O=(label,obsOperation,extra={})=>({type:'obs',label,obsOperation,...extra,icon:'Radio',color:'#ef9fbc'});
const aiKnobs={'knob1.ccw':S('입력 커서 · 이전 단어','CTRL','LEFT'),'knob1.cw':S('입력 커서 · 다음 단어','CTRL','RIGHT'),'knob1.press':S('입력창 줄바꿈','SHIFT','ENTER'),'knob3.ccw':M('답변 위로',120),'knob3.cw':M('답변 아래로',-120),'knob3.press':S('문서·입력 끝으로','CTRL','END')};
const handoff='이 작업을 다른 대화에서 이어갈 수 있도록 목표, 확정 사항, 완료한 작업, 관련 파일·경로, 남은 문제, 바로 할 다음 행동을 정리해줘. 사실과 아직 확인하지 못한 내용을 구분해줘.';
// ChatGPT Windows 26.1111: native command definitions, cross-checked with the
// official desktop Commands reference. Web/legacy desktop shortcuts differ.
const gptKeys=[
 S('새 대화','CTRL','SHIFT','O'),{...S('임시 대화','CTRL','SHIFT','N'),comment:'ChatGPT 채팅 모드에서 새 임시 대화를 엽니다.'},S('명령 메뉴','CTRL','SHIFT','P'),S('대화 안에서 찾기','CTRL','F'),S('사이드바 접기·펼치기','CTRL','SHIFT','S'),
 S('모델·추론 선택','CTRL','SHIFT','M'),S('최근 모델 선택','ALT','M'),{...S('받아쓰기 켜기·끄기','CTRL','SHIFT','D'),comment:'앱의 받아쓰기 기능과 마이크 권한이 준비된 경우 사용합니다.'},S('대화 이름 변경','CTRL','ALT','R'),S('대화 고정·해제','CTRL','ALT','P'),
 S('뒤로 이동','CTRL','['),S('앞으로 이동','CTRL',']'),S('대화 링크 복사','CTRL','ALT','L'),S('앱 설정','CTRL',','),S('단축키 목록','CTRL','/')
];
const gptKnobs={'knob1.ccw':S('이전 대화·탭','CTRL','SHIFT','TAB'),'knob1.cw':S('다음 대화·탭','CTRL','TAB'),'knob1.press':S('모델·추론 선택','CTRL','SHIFT','M'),'knob3.ccw':M('대화 위로',120),'knob3.cw':M('대화 아래로',-120),'knob3.press':S('대화 안에서 찾기','CTRL','F')};
const claude=[
 ['초안 완성','아래 초안을 목적과 독자에 맞는 완성된 글로 다듬어줘. 새 사실은 만들어 넣지 말아줘.\n목적·독자:\n초안:\n'],
 ['문장 다듬기','아래 글의 의미를 유지하면서 어색한 표현, 문장 연결, 맞춤법을 자연스럽게 다듬어줘.\n\n'],
 ['중복 줄이기','아래 글에서 중복과 군더더기를 줄여줘. 중요한 조건, 수치, 근거는 남겨줘.\n\n'],
 ['업무 보고서','아래 내용을 배경, 진행 내용, 결과, 문제, 다음 행동 순서의 간결한 업무 보고서로 작성해줘.\n\n'],
 ['정중하게 수정','아래 문장을 정중하지만 지나치게 딱딱하지 않은 업무 말투로 바꿔줘. 뜻을 추가하지 말아줘.\n\n'],
 ['문서 구조','아래 자료의 제목, 소제목, 문단 순서를 설계해줘. 읽는 사람이 이해하기 쉬운 순서로 묶어줘.\n\n'],
 ['모순·누락 검토','아래 문서의 모순, 누락, 모호한 표현을 찾아줘. 위치와 문제 이유, 수정안을 함께 적어줘.\n\n'],
 ['표로 정리','아래 내용을 비교·검색하기 쉬운 표로 정리해줘. 원문에 없는 정보는 빈칸 또는 미확인으로 표시해줘.\n\n'],
 ['표를 설명문으로','아래 표의 핵심 변화와 의미를 읽기 쉬운 설명문으로 작성해줘. 수치를 정확히 보존해줘.\n\n'],
 ['자막 다듬기','아래 자막을 짧고 읽기 쉽게 다듬어줘. 의미와 말투를 유지하고 타임코드가 있으면 보존해줘.\n\n'],
 ['설명 영상 대본','다음 주제의 설명 영상 대본을 도입, 핵심 설명, 예시, 마무리 순서로 작성해줘.\n주제:\n대상 시청자:\n영상 길이:\n'],
 ['수정 요구사항','아래 아이디어를 개발자가 구현할 수 있는 요구사항으로 정리해줘. 현재 문제, 원하는 동작, 예외 상황, 완료 기준을 포함해줘.\n\n'],
 ['코드·설정 검토','아래 코드 또는 설정을 검토해서 실제 오류 가능성이 있는 부분을 우선순위와 근거로 설명해줘. 필요한 수정은 최소 범위로 제안해줘.\n\n'],
 ['검증 방법','현재 결과물이 요구사항을 충족하는지 확인할 검증 방법과 예상 결과를 작성해줘. 정상 사례와 경계 사례를 포함해줘.'],
 ['대화 인계',handoff]
];
const hermes=[
 ['오늘 할 일','내가 제공한 업무 내용을 기준으로 오늘 할 일과 우선순위를 정리해줘. 필요한 자료가 없으면 요청해줘.'],
 ['파일 목록','지정한 폴더의 파일 목록을 종류와 날짜별로 정리해줘. 파일은 변경하지 말아줘.\n대상 폴더:\n'],
 ['파일 요약','내가 지정한 파일들을 읽고 각 파일의 핵심 내용과 공통 주제를 요약해줘.\n대상 파일:\n'],
 ['분류안','지정한 폴더의 파일을 분류할 기준과 이동안을 표로 제시해줘. 우선 실제 이동은 하지 말아줘.\n대상 폴더:\n'],
 ['이름 변경안','다음 규칙에 따른 파일 이름 변경안을 기존 이름 → 새 이름 표로 보여줘. 이름 충돌을 확인하고 아직 변경하지 말아줘.\n대상 폴더:\n이름 규칙:\n'],
 ['중복 후보','지정한 폴더의 중복 파일 후보를 찾아 근거와 함께 목록으로 정리해줘. 파일은 삭제하지 말아줘.\n대상 폴더:\n'],
 ['작업 계획','현재 목표를 달성하기 위한 작업 계획을 의존 순서대로 작성해줘. 각 단계의 입력, 결과물, 완료 기준을 적어줘.'],
 ['진행 상황','현재 작업에서 완료한 일, 진행 중인 일, 막힌 이유, 남은 일을 간결하게 보고해줘.'],
 ['로그 원인 분석','아래 로그를 분석해 최초 원인과 후속 오류를 구분하고, 확인 및 수정 순서를 제안해줘.\n\n'],
 ['웹 조사','아래 주제를 조사해서 핵심 결론, 비교표, 출처 링크, 확인 날짜를 정리해줘.\n조사 주제:\n중요한 기준:\n'],
 ['변경 내역','이번 작업에서 변경한 파일과 변경 이유, 검증 결과, 아직 확인하지 못한 내용을 정리해줘.'],
 ['자동화 설계','다음 반복 업무를 자동화하는 방법을 설계해줘. 필요한 도구, 입력 데이터, 실패 시 처리와 수동 확인 지점을 설명해줘.\n반복 업무:\n'],
 ['재시도 계획','실패한 작업의 원인을 먼저 확인하고 재시도 계획을 세워줘. 이미 완료한 작업을 중복 실행하지 않도록 점검해줘.'],
 ['절차 재사용','이번에 성공한 작업 절차를 다음에도 사용할 수 있는 지침으로 정리해줘. 사전 조건, 단계, 검증 방법, 자주 발생한 오류를 포함해줘.'],
 ['대화 인계',handoff]
];
function profile(id,name,description,keys,knobs){const bindings={...Object.fromEntries(keys.map((a,i)=>[`key${i+1}`,a])),...knobs};return {id,presetId:`monodeck.work.${id}.v1`,name,description,matchProcess:'',bindings,layers:Object.fromEntries([1,2,3].map(n=>[n,structuredClone(bindings)]))};}
const promptDescription='15개 요청문 · 입력창을 먼저 클릭하세요. 자동 전송하지 않습니다. 작은 노브: 단어 단위 커서 이동 / 클릭 줄바꿈. 큰 노브: 포인터 아래 스크롤 / 클릭 끝으로. 그룹 1·2·3 동일. 자동 앱 전환은 꺼진 상태로 추가됩니다.';
const gptProfile=profile('gpt','GPT · 앱 기능','ChatGPT Windows 앱(26.1111 계열) 기능 단축키 15개. 새 대화·임시 대화·명령 메뉴·대화 내 검색·모델·받아쓰기·대화 관리. 작은 노브: 이전/다음 대화·탭 / 클릭 모델 선택. 큰 노브: 포인터 아래 스크롤 / 클릭 대화 내 검색. ChatGPT 앱을 앞에 두세요. 임시 대화는 ChatGPT 채팅 모드, 받아쓰기는 기능·마이크 권한이 필요합니다. 사용자 지정 단축키는 앱 설정에 맞춰 수정하세요.',gptKeys,gptKnobs);gptProfile.presetId='monodeck.work.gpt.v2';
const profiles=[gptProfile,profile('claude','Claude · 작성·수정',promptDescription,claude.map(([a,b])=>T(a,b)),aiKnobs),profile('hermes','Hermes · 작업 관리',promptDescription,hermes.map(([a,b])=>T(a,b)),aiKnobs)];
profiles.push(profile('whale','웨일 · 탐색·수집','웨일 창을 앞에 두고 사용하세요. 작은 노브: 탭 이동 / 클릭 닫은 탭 복원. 큰 노브: 스크롤 / 클릭 페이지 맨 위. 14번은 네이버 시작 페이지이며 원하는 업무 URL로 편집할 수 있습니다.',[
 S('새 탭','CTRL','T'),S('닫은 탭 복원','CTRL','SHIFT','T'),S('탭 닫기','CTRL','W'),S('이전 탭','CTRL','SHIFT','TAB'),S('다음 탭','CTRL','TAB'),
 Q('주소 복사',[S('주소 선택','CTRL','L'),S('주소 복사','CTRL','C'),S('페이지로','ESC')]),
 Q('선택 문구 검색',[S('선택 문구 복사','CTRL','C'),D(80),S('새 탭','CTRL','T'),D(200),S('검색 입력','CTRL','K'),S('붙여넣기','CTRL','V'),S('검색','ENTER')]),
 S('페이지 찾기','CTRL','F'),S('북마크','CTRL','D'),S('전체 캡처','ALT','3'),S('영역 캡처','ALT','1'),S('다운로드','CTRL','J'),S('방문 기록','CTRL','H'),
 Q('업무 시작 · 네이버',[S('새 탭','CTRL','T'),D(200),T('주소','https://www.naver.com'),S('열기','ENTER')]),
 T('자료 메모 양식','제목: \n출처 URL: \n핵심 내용: \n활용할 점: \n다음 행동: \n')
],{'knob1.ccw':S('이전 탭','CTRL','SHIFT','TAB'),'knob1.cw':S('다음 탭','CTRL','TAB'),'knob1.press':S('닫은 탭 복원','CTRL','SHIFT','T'),'knob3.ccw':M('페이지 위로',120),'knob3.cw':M('페이지 아래로',-120),'knob3.press':S('페이지 맨 위','CTRL','HOME')}));
profiles.push(profile('lightroom5','Lightroom 5 · 선별·보정','Lightroom 5.7 계열 기본 단축키. 1·2번은 표시 후 다음 사진으로 이동합니다. 텍스트 입력 중에는 사용하지 마세요. 작은 노브: 사진 이동 / 클릭 확대. 큰 노브: 선택한 현상 슬라이더 ± / 클릭 보정 전 보기. 노브로 조절할 슬라이더를 먼저 선택하세요.',[
 Q('채택 → 다음',[S('채택','P'),D(80),S('다음 사진','RIGHT')]),Q('제외 → 다음',[S('제외','X'),D(80),S('다음 사진','RIGHT')]),S('표시 해제','U'),S('별점 3','3'),S('별점 5','5'),S('격자 보기','G'),S('한 장 보기','E'),S('현상 모듈','D'),S('자르기','R'),S('화이트밸런스','W'),S('보정 복사','CTRL','SHIFT','C'),S('보정 붙여넣기','CTRL','SHIFT','V'),S('보정 동기화','CTRL','SHIFT','S'),S('전·후 비교','Y'),S('내보내기','CTRL','SHIFT','E')
],{'knob1.ccw':S('이전 사진','LEFT'),'knob1.cw':S('다음 사진','RIGHT'),'knob1.press':S('확대 전환','Z'),'knob3.ccw':S('선택 슬라이더 −','DOWN'),'knob3.cw':S('선택 슬라이더 +','UP'),'knob3.press':S('보정 전 보기','\\')}));
profiles.push(profile('obs','OBS · 장면·오디오','OBS WebSocket 5 연결 필요. 작은 노브: 장면 후보 선택 / 클릭 송출 장면 확정. 큰 노브: 지정 캡처 소스 ±1dB / 클릭 음소거. 프리셋 라이브러리 → OBS 연결에서 오디오 대상을 선택하세요. 1~5번은 OBS 장면 목록 순서이며 실제 이름은 연결 화면에 표시합니다. 방송 시작·종료는 포함하지 않습니다.',[
 ...Array.from({length:5},(_,i)=>O(`장면 ${i+1}`, 'sceneSelect',{sceneIndex:i})),O('녹화 시작','startRecord'),O('녹화 일시정지','pauseRecord'),O('녹화 재개','resumeRecord'),O('녹화 종료','stopRecord'),O('리플레이 저장','saveReplay'),O('마이크 음소거','mute',{inputRole:'microphone'}),O('마이크 켜기','unmute',{inputRole:'microphone'}),O('캡처 음소거','mute',{inputRole:'volume'}),O('캡처 소리 켜기','unmute',{inputRole:'volume'}),O('스튜디오 모드','studioToggle')
],{'knob1.ccw':O('이전 장면 후보','scenePrevious'),'knob1.cw':O('다음 장면 후보','sceneNext'),'knob1.press':O('장면 선택 확정','sceneConfirm'),'knob3.ccw':O('캡처 볼륨 −1dB','volumeDown',{inputRole:'volume'}),'knob3.cw':O('캡처 볼륨 +1dB','volumeUp',{inputRole:'volume'}),'knob3.press':O('캡처 음소거 전환','toggleMute',{inputRole:'volume'})}));
const pack={format:'mono-deck-preset-pack',version:1,name:'업무 스타터 · AI / 웨일 / Lightroom / OBS',description:'새 PC 페이지 6개를 추가합니다. 기존 페이지·순서·선택 상태·공통 전환 노브는 유지됩니다. 프리셋마다 15키와 보조 노브 2개를 그룹 1·2·3 모두에 배치합니다. OBS는 별도 연결이 필요합니다.',knobOrder:[1,2,3],profiles};
parsePack(pack);
fs.mkdirSync(path.join(root,'presets'),{recursive:true});
fs.writeFileSync(path.join(root,'assets/work-starter.monodeck.json'),JSON.stringify(pack,null,2));
fs.writeFileSync(path.join(root,'presets/work-starter.monodeck.json'),JSON.stringify(pack,null,2));
for(const p of profiles)fs.writeFileSync(path.join(root,`presets/${p.id}.monodeck.json`),JSON.stringify({...pack,name:p.name,description:p.description,profiles:[p]},null,2));
console.log(`Generated ${profiles.length} pages, ${profiles.length*15} key bindings, all 3 device groups.`);
const mixer=profile('obs-mixer','OBS · 교회 오디오 믹서','키 1~15로 연결한 오디오를 선택합니다. 큰 노브: 선택 소스 ±0.5dB / 클릭 음소거. 왼쪽 작은 노브: 연결된 소스 이동 / 클릭 현재 상태 표시. 오른쪽 위 노브: 공통 페이지 이동. 프리셋 라이브러리 → OBS 연결에서 HDMI·믹서 USB·송출 PC 등의 실제 소스를 키에 연결하세요. 선택만으로 볼륨을 바꾸지 않습니다.',
  Array.from({length:15},(_,i)=>O(`오디오 ${String(i+1).padStart(2,'0')} 선택`,'sourceSelect',{audioIndex:i})),
  {'knob1.ccw':O('이전 오디오 소스','sourcePrevious'),'knob1.cw':O('다음 오디오 소스','sourceNext'),'knob1.press':O('선택 소스 상태','sourceStatus'),'knob3.ccw':O('선택 소스 −0.5dB','volumeDown',{inputRole:'selected',volumeStepDb:0.5}),'knob3.cw':O('선택 소스 +0.5dB','volumeUp',{inputRole:'selected',volumeStepDb:0.5}),'knob3.press':O('선택 소스 음소거','toggleMute',{inputRole:'selected'})});
const mixerPack={...pack,name:mixer.name,description:mixer.description,profiles:[mixer]};parsePack(mixerPack);
for(const dir of ['assets','presets'])fs.writeFileSync(path.join(root,dir,'obs-mixer.monodeck.json'),JSON.stringify(mixerPack,null,2));
console.log('Generated additional OBS audio mixer page.');
