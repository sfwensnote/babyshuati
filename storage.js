'use strict';
const STORAGE_KEY = 'babyshuati-data-v1';
let bankPromise;
const now = () => Math.floor(Date.now() / 1000);
const fresh = () => ({version:1, attempts:[], wrong:{}, exams:[], nextId:1});
function readData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return fresh();
  try {
    const data = JSON.parse(saved);
    if (data.version !== 1 || !Array.isArray(data.attempts) || !Array.isArray(data.exams) || !data.wrong || typeof data.wrong !== 'object') throw Error();
    return data;
  } catch { throw new Error('本地数据无法读取，请使用备份恢复。'); }
}
function saveData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch { throw new Error('保存失败，请检查浏览器存储空间或隐私设置。'); }
}
async function loadBank() {
  if (!bankPromise) bankPromise = fetch('bank.json').then(r => {
    if (!r.ok) throw new Error('题库加载失败，请刷新后重试。');
    return r.json();
  }).catch(e => { bankPromise = null; throw e; });
  return bankPromise;
}
function publicQuestion(q) {
  const {correct, explanation, ...rest} = q;
  return rest;
}
function record(data, q, selected, mode, request, response) {
  const correct = q.type === 'code' ? selected === 1 : q.correct === null ? null : selected === q.correct;
  data.attempts.push({question:q.id, selected, correct, mode, created:now(), request, response});
  if (correct === false) {
    const old = data.wrong[q.id] || {misses:0};
    data.wrong[q.id] = {misses:old.misses+1, active:true, updated:now()};
  } else if (correct === true && mode === 'review' && data.wrong[q.id]) {
    data.wrong[q.id].active = false;
  }
}
function shuffle(array) {
  const result = [...array];
  for (let i=result.length-1;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    [result[i],result[j]] = [result[j],result[i]];
  }
  return result;
}
function examView(exam, bank) {
  const questions = exam.questions.map(id => bank.questions.find(q=>q.id===id)).filter(Boolean);
  if (questions.length !== exam.questions.length) throw new Error('考试包含已不存在的题目，请恢复对应版本的题库。');
  const result = {id:exam.id,course:exam.course,answers:exam.answers,finished:exam.finished,
    questions:exam.finished ? questions : questions.map(publicQuestion)};
  if (exam.finished) {
    result.grades = exam.grades || {};
    result.pending = questions.filter(q=>q.type==='code' && !(q.id in result.grades)).length;
    const gradable = questions.filter(q=>q.correct!==null);
    result.gradedTotal = gradable.length;
    if (!result.pending) result.correct = gradable.reduce((n,q)=>n + (q.type==='code' ? Number(result.grades[q.id]===1) : Number(exam.answers[q.id]===q.correct)),0);
  }
  return result;
}
async function localApi(path, body) {
  const bank = await loadBank();
  const data = readData();
  const [route, query=''] = path.split('?');
  const params = new URLSearchParams(query);
  const course = body?.course || params.get('course');
  const questions = bank.questions;
  const needsReview = q => q.correct !== null && data.wrong[q.id]?.active;
  if (route === 'overview') return Object.entries(bank.courses).map(([id,name])=>({id,name,modules:bank.modules[id],
    practiced:new Set(data.attempts.filter(a=>a.question.startsWith(id+'-')).map(a=>a.question)).size,
    wrong:questions.filter(q=>q.course===id && needsReview(q)).length,
    originals:questions.filter(q=>q.course===id && q.source==='supplied').length,
    pasts:questions.filter(q=>q.course===id && q.source==='past').length,
    total:questions.filter(q=>q.course===id).length}));
  if (!bank.courses[course]) throw new Error('请选择科目。');
  if (route === 'questions') {
    const mode=params.get('mode') || 'bank';
    return questions.filter(q=>q.course===course && (mode!=='past' || q.source==='past') &&
      (mode!=='original' || q.source==='supplied') && (mode!=='review' || needsReview(q)))
      .map(q=>({...publicQuestion(q), ...(mode==='review' ? {misses:data.wrong[q.id].misses} : {})}));
  }
  if (route === 'answer' || route === 'answer/example') {
    const q = questions.find(q=>q.id===body.id && q.course===course);
    if (!q) throw new Error('找不到题目。');
    if (route === 'answer/example') return q;
    if (!data.attempts.some(a=>a.request===body.request)) {
      record(data,q,body.selected,body.mode,body.request,body.response); saveData(data);
    }
    return q;
  }
  if (route === 'exams') {
    const all = data.exams.filter(e=>e.course===course).sort((a,b)=>b.id-a.id);
    return {active:all.find(e=>!e.finished) ? examView(all.find(e=>!e.finished),bank) : null,
      history:all.filter(e=>e.finished).map(e=>{const v=examView(e,bank); return {id:v.id,total:v.gradedTotal,correct:v.correct,pending:v.pending,finished:v.finished};})};
  }
  if (route === 'exam/start') {
    let exam=data.exams.find(e=>e.course===course && !e.finished);
    if (!exam) {
      let picked=[];
      for (const module of bank.modules[course]) {
        const kind=body.kind || 'objective';
        const pool=questions.filter(q=>q.course===course && q.module===module.name &&
          ['single','multiple','judge','number','code'].includes(q.type) &&
          (kind==='all' || kind===q.type || (kind==='objective' && q.type!=='code')));
        const count=body.counts[module.name] || 0;
        if (!Number.isInteger(count) || count<0 || count>pool.length) throw new Error(module.name+'题量有误。');
        picked.push(...shuffle(pool).slice(0,count).map(q=>q.id));
      }
      if (!picked.length) throw new Error('至少选 1 道题。');
      exam={id:data.nextId++,course,questions:shuffle(picked),answers:{},grades:{},created:now(),finished:null};
      data.exams.push(exam); saveData(data);
    }
    return examView(exam,bank);
  }
  if (route==='exam' || route.startsWith('exam/')) {
    const exam=data.exams.find(e=>String(e.id)===String(body?.id ?? params.get('id')) && e.course===course);
    if (!exam) throw new Error('找不到这场考试。');
    if (route==='exam') return examView(exam,bank);
    if (route==='exam/discard') { if (exam.finished) throw new Error('已交卷的考试不能放弃。'); data.exams=data.exams.filter(e=>e.id!==exam.id); saveData(data); return {}; }
    if (route==='exam/save' && !exam.finished) {
      if (!exam.questions.includes(body.question)) throw new Error('题目无效。');
      if (body.selected===null || body.selected===undefined || body.selected==='' || body.selected===0 && questions.find(q=>q.id===body.question)?.multiple) delete exam.answers[body.question];
      else exam.answers[body.question]=body.selected;
    } else if (route==='exam/finish' && !exam.finished) {
      if (Object.keys(exam.answers).length!==exam.questions.length) throw new Error('请答完全部题目再交卷。');
      for (const id of exam.questions) { const q=questions.find(q=>q.id===id); if (q.type!=='code') record(data,q,exam.answers[id],'exam'); }
      exam.finished=now();
    } else if (route==='exam/grade' && exam.finished) {
      const q=questions.find(q=>q.id===body.question && exam.questions.includes(q.id) && q.type==='code');
      if (!q) throw new Error('只能自评已交卷的大题。');
      if (!(q.id in exam.grades)) { exam.grades[q.id]=body.selected; record(data,q,body.selected,'exam',undefined,exam.answers[q.id]); }
    }
    saveData(data); return examView(exam,bank);
  }
  throw new Error('找不到此功能。');
}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('export-data').addEventListener('click',()=>{
    try { const blob=new Blob([JSON.stringify(readData(),null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='刷题数据备份-'+new Date().toISOString().slice(0,10)+'.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
    catch(e) { alert(e.message); }
  });
  document.getElementById('import-data').addEventListener('change',async event=>{
    try { const file=event.target.files[0]; if (!file) return; const data=JSON.parse(await file.text());
      if (data.version!==1 || !Array.isArray(data.attempts) || !Array.isArray(data.exams) || !data.wrong || typeof data.wrong!=='object' || !Number.isInteger(data.nextId)) throw Error('备份文件格式不正确。');
      if (confirm('恢复会覆盖当前浏览器中的学习记录，继续吗？')) { saveData(data); location.reload(); }
    } catch(e) { alert(e.message || '恢复失败。'); } finally { event.target.value=''; }
  });
});
