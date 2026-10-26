/* Read-only interpretation of stored AI input. No requests or mutations. */
(function(root){
  'use strict';
  const validID=value=>typeof value==='string'&&value.length>0&&value.length<=100;
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  function timestamp(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value))return null;
    const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
  }
  function source(row){
    return {check:'기능 점검',login:'로그인 이벤트',prometheus:'Prometheus 경보',historical_context:'과거 사건'}[row.kind]||'입력 근거';
  }
  function observation(row){
    const p=object(row.payload)?row.payload:{};
    if(row.kind==='prometheus')return (typeof p.alert_name==='string'?p.alert_name:'경보')+' · '+({firing:'발생 중',pending:'발생 대기',normal:'정상 지표 확인',unknown:'미확인'}[p.state]||'상태 미제공');
    if(row.kind==='check'){
      const values=[];
      if(Number.isFinite(p.status_code))values.push('HTTP '+p.status_code);
      if(typeof p.probe_success==='boolean')values.push('점검 '+(p.probe_success?'성공':'실패'));
      if(Number.isFinite(p.duration_ms))values.push('응답 '+p.duration_ms+' ms');
      return values.join(' · ')||'상태 값 미제공';
    }
    if(row.kind==='login')return typeof p.event_type==='string'?p.event_type:'로그인 이벤트';
    return '별도 입력 근거 · 원문 확인';
  }
  function build(incident,job){
    const known=Array.isArray(job?.input_evidence),rows=known?job.input_evidence:[];
    const current=new Map(),historical=new Map();let malformed=0;
    for(const row of rows){
      if(!object(row)||!validID(row.id)){++malformed;continue}
      (row.kind==='historical_context'?historical:current).set(row.id,row);
    }
    const referencesKnown=Array.isArray(job?.result?.evidence_ids);
    const cited=new Set(referencesKnown?job.result.evidence_ids.filter(validID):[]);
    const currentRows=[...current.values()].map(row=>({...row,source:source(row),observation:observation(row),cited:cited.has(row.id)}));
    const histories=[...historical.values()].map(row=>{
      const p=object(row.payload)?row.payload:{};
      const match=/^history:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(row.id);
      const incidentID=match&&p.incident_id===match[1]&&match[1]!==incident.id?match[1]:null;
      return {id:row.id,incidentID,cited:cited.has(row.id),payload:p,
        notes:Array.isArray(p.action_notes)?p.action_notes.filter(v=>typeof v==='string').slice(0,3).map(v=>v.slice(0,500)):[]};
    });
    const unmatched=[...cited].filter(id=>!current.has(id)&&!historical.has(id));
    const successes=Array.isArray(job?.history)?job.history.filter(a=>a?.outcome==='succeeded'&&timestamp(a.finished_at)!==null).sort((a,b)=>timestamp(a.finished_at)-timestamp(b.finished_at)):[];
    const start=timestamp(incident.detected_at),end=timestamp(incident.closed_at);
    const sourceRows=Array.isArray(incident.evidence)&&incident.evidence.length?incident.evidence:currentRows;
    const failures=sourceRows.filter(row=>{
      const p=object(row?.payload)?row.payload:{};
      if(incident.rule_id==='login_failures')return row.kind==='login'&&p.event_type==='login_failed';
      return row?.kind==='check'&&((Number.isFinite(p.status_code)&&p.status_code>=500&&p.status_code<=599)||(p.status_code===0&&p.probe_success===false));
    }).map(row=>timestamp(row.occurred_at)).filter(value=>value!==null).sort((a,b)=>a-b);
    return {known,referencesKnown,current:currentRows,histories,malformed,unmatched,
      currentCitations:referencesKnown?currentRows.filter(r=>r.cited).length:null,
      historyCitations:referencesKnown?histories.filter(r=>r.cited).length:null,
      analysisAt:successes.at(-1)?.finished_at||null,
      failureWindow:failures.length?{first:new Date(failures[0]).toISOString(),last:new Date(failures.at(-1)).toISOString(),count:failures.length,source:sourceRows===incident.evidence?'detail_evidence':'ai_input'}:null,
      lifecycleSeconds:incident.status==='closed'&&start!==null&&end!==null&&end>=start?Math.floor((end-start)/1000):null};
  }
  function closedMonitoring(incident){
    const end=timestamp(incident.closed_at);
    const rows=(Array.isArray(incident.evidence)?incident.evidence:[]).filter(row=>{
      const at=timestamp(row?.occurred_at),p=object(row?.payload)?row.payload:{};
      return row?.kind==='prometheus'&&end!==null&&at!==null&&at<=end
        &&p.rule_id===incident.rule_id
        &&['firing','pending','normal','unknown'].includes(p.state);
    }).sort((a,b)=>timestamp(b.occurred_at)-timestamp(a.occurred_at));
    const row=rows[0];
    return row?{state:row.payload.state,at:row.occurred_at}:null;
  }
  function jobState(job,kind){
    if(!job)return {label:kind==='ai'?'분석 기록 없음':'미발송 / 기록 없음',tone:'unknown',lastAttempt:null};
    const times=(Array.isArray(job.history)?job.history:[]).map(a=>a?.started_at).filter(v=>timestamp(v)!==null).sort((a,b)=>timestamp(a)-timestamp(b));
    const at=timestamp(job.last_attempt_at)!==null?job.last_attempt_at:times.at(-1)||null;
    let label={pending:'대기',running:'실행 중',failed:'실패'}[job.status],tone=job.status==='failed'?'failed':'pending';
    if(!label){
      if(job.status!=='succeeded'){label='처리 상태 미확인';tone='unknown'}
      else if(job.mode==='demo'){label='시험 처리 · 실제 연결 아님';tone='unknown'}
      else if(job.mode!=='live'){label='완료 · 연결 방식 미확인';tone='unknown'}
      else if(kind==='ai'){label='분석 성공';tone='success'}
      else if(job.sent===true||job.result?.sent===true){label='전송 성공';tone='success'}
      else{label='완료 · 전송 미확인';tone='unknown'}
    }
    return {label,tone,lastAttempt:at};
  }
  root.SchutzIncidentContext={build,jobState,closedMonitoring};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.SchutzIncidentContext;
})(typeof window!=='undefined'?window:globalThis);

