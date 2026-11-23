const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const switcher = document.querySelector('#switcher');
const labels = {bank: '题库', past: '历年真题', original: '题库原题', review: '错题复习', exam: '自定义考试'};
const letters = 'ABCD';
const kinds = {single:'单选', multiple:'多选', judge:'判断', number:'填空', code:'大题'};
const sources = {past:'历年真题', supplied:'题库原题', ai:'AI 模拟题'};
let courses = [], course, page, epoch = 0, timer;
let practice, exam, history, index, busy = false;

const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const inlineText = value => esc(value).replace(/`([^`\n]+)`/g,'<code class="inline-code">$1</code>');
function richText(value) {
  const parts = String(value).split(/```([\w+-]*)\n([\s\S]*?)```/g);
  return parts.map((part,i) => {
    if (i % 3 === 1) return '';
    if (i % 3 === 2) return '<pre class="code-block"><code>' + esc(part) + '</code></pre>';
    return part.split(/\n{2,}/).filter(Boolean).map(paragraph =>
      '<p class="rich-paragraph">' + inlineText(paragraph).replace(/\n/g,'<br>') + '</p>').join('');
  }).join('');
}
const link = (id, view = 'bank') => '#' + id + '/' + view;
const pdf = id => '<a href="study/' + id + '.pdf" target="_blank" rel="noopener">复习讲义 PDF</a>';
const args = params => '?' + new URLSearchParams(params);
const percent = (correct, total) => Math.round(correct * 1000 / total) / 10;
const date = timestamp => new Intl.DateTimeFormat('zh-CN', {dateStyle:'medium',timeStyle:'short'}).format(timestamp * 1000);

async function api(path, body) {
  return localApi(path, body);
}
function alertUser(message) {
  clearTimeout(timer);
  notice.textContent = message;
  timer = setTimeout(() => { notice.textContent = ''; }, 5200);
}
function action(label, id, {kind = '', value = '', disabled = false} = {}) {
  return '<button type="button" class="' + kind + '" data-action="' + id +
    '" data-value="' + esc(value) + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
}
function views(c) {
  return Object.entries(labels).filter(([id]) => id !== 'original' || c.originals)
    .filter(([id]) => id !== 'past' || c.pasts);
}
function tabs() {
  return '<h1>' + course.name + '</h1><nav class="tabs" aria-label="练习方式">' +
    views(course).map(([id, label]) => '<a href="' + link(course.id,id) + '"' +
      (page === id ? ' aria-current="page"' : '') + '>' + label + '</a>').join('') + pdf(course.id) + '</nav>';
}
function show(content) {
  app.innerHTML = (course ? tabs() : '') + content;
  app.inert = false;
  app.setAttribute('aria-busy', 'false');
}
function home() {
  show('<h1>选择科目</h1><div class="courses">' + courses.map(c =>
    '<section class="course-card ' + c.id + '"><div class="course-head"><h2>' + c.name +
    '</h2><span>' + c.total + ' 道题</span></div><div class="course-body"><nav class="home-links" aria-label="' +
    c.name + '入口">' + views(c).map(([id,label]) => '<a class="button ' + (id==='bank'?'primary':'') +
    '" href="' + link(c.id,id) + '">' + label + '</a>').join('') + '</nav><ul class="weights" aria-label="考纲权重">' +
    c.modules.filter(m => m.weight).map(m => '<li><span>' + esc(m.name) + '</span><span class="track" aria-hidden="true"><b style="width:' +
      (m.weight / 30 * 100) + '%"></b></span><span>' + m.weight + '%</span></li>').join('') +
    '</ul><div class="course-foot">' + pdf(c.id) + '<span class="muted">已做 ' + c.practiced + ' 题 · 待复习 ' +
    c.wrong + ' 题</span></div></div></section>').join('') + '</div>');
}
async function navigate() {
  const version = ++epoch;
  busy = false;
  const [id, view] = location.hash.slice(1).split('/');
  app.inert = true;
  app.setAttribute('aria-busy', 'true');
  try {
    const overview = await api('overview');
    if (version !== epoch) return;
    courses = overview;
    course = courses.find(c => c.id === id);
    page = view in labels && Object.hasOwn(labels,view) ? view : 'bank';
    document.title = course ? course.name + ' · ' + (views(course).find(([id]) => id === page)?.[1] || labels.bank) : '刷题';
    switcher.innerHTML = courses.map(c => '<a href="' + link(c.id, course ? page : 'bank') + '"' +
      (c.id === course?.id ? ' aria-current="true"' : '') + '>' + c.name + '</a>').join('') +
      '';
    if (!course) return home();
    if (page === 'exam') return await loadExams(version);
    const items = await api('questions' + args({course: course.id, mode: page}));
    if (version !== epoch) return;
    practice = {all: items, items, filter: '', facets:{source:'',topicCode:'',type:''}, index:0,
      selected:null, result:null, request:null, written:'', example:null};
    renderPractice();
  } catch (error) {
    if (version === epoch) show('<section class="panel empty"><p>' + esc(error.message) + '</p>' + action('重试','reload') + '</section>');
  }
}
function isSelected(q, answer, index) {
  return q.multiple ? Boolean(answer & (1 << index)) : answer === index;
}
function answerText(q) {
  if (q.type === 'number') return q.correct;
  if (q.type === 'judge') return q.choices[q.correct];
  return q.choices.map((_,i) => isSelected(q,q.correct,i) ? letters[i] : '').filter(Boolean).join('、');
}
function question(q, num, total, selected, result, misses, written = '') {
  const [title, ...code] = q.stem.split('\n');
  const source = q.paper ? q.years.join(' / ') + ' 年 ' + q.paper + ' 真题' :
    q.years?.length ? q.years.join(' / ') + ' 年真题' : q.sourceNumber ? '题库原题 #' + q.sourceNumber : sources[q.source];
  const type = kinds[q.type] || (q.multiple ? '多选参考题' : '参考题');
  const gradeable = result && result.correct !== null && selected != null;
  const feedback = result ? '<div class="feedback' + (gradeable && selected !== result.correct ? ' incorrect' : '') +
    '" role="status"><strong>' + (!gradeable ? (q.type === 'code' ? '参考答案 · 待自评' : '已记录 · 参考解析') : q.type === 'code' ?
      (selected ? '自评正确' : '已加入错题') : (selected === result.correct ? '答对了' : '答错了') +
      ' · 正确答案 ' + esc(answerText(result))) + '</strong>' +
    richText(result.explanation) +
    '</div>' : '';
  let inputs;
  if (q.type === 'code') {
    inputs = '<label class="written-label">你的作答<textarea name="' + (page === 'exam' ? 'exam-written' : 'written') +
      '" spellcheck="false" maxlength="10000"' + (result || (page !== 'exam' && practice.example) ? ' readonly' : '') +
      '>' + esc(written) + '</textarea></label>';
  } else if (q.type === 'number') {
    inputs = '<label class="written-label">填写整数<input type="text" inputmode="numeric" maxlength="10" name="number" value="' +
      esc(selected ?? '') + '"' + (result ? ' disabled' : '') + '></label>';
  } else {
    inputs = '<fieldset class="options" aria-labelledby="stem"' + (result ? ' disabled' : '') + '>' +
      q.choices.map((choice,i) => {
        const kind = !gradeable ? '' : isSelected(q,result.correct,i) ? ' correct' : isSelected(q,selected,i) ? ' incorrect' : '';
        return '<label class="option' + kind + '"><input type="' + (q.multiple ? 'checkbox' : 'radio') +
          '" name="answer" value="' + i + '"' + (isSelected(q,selected,i) ? ' checked' : '') +
          '><span class="letter">' + letters[i] + '.</span><span class="option-text">' + richText(choice) + '</span></label>';
      }).join('') + '</fieldset>';
  }
  return '<div class="tags"><span>' + esc(q.module) + ' · ' + type +
    (source ? ' <span class="source-tag' + (q.source === 'ai' ? ' simulated' : '') + '">' + esc(source) + '</span>' : '') +
    (misses ? ' · 答错 ' + misses + ' 次' : '') + '</span><span>' + num + ' / ' + total +
    '</span></div>' + (q.topic ? '<p class="topic">' + esc(q.topic) + (q.basis ? ' · ' + esc(q.basis) : '') + '</p>' : '') +
    '<h2 id="stem">' + inlineText(title) + '</h2>' + (code.length ? richText(code.join('\n')) : '') +
    inputs + feedback;
}
function matchesFilter(q, value) {
  if (!value) return true;
  if (page === 'original' && course.id === 'python') return q.years.includes(Number(value));
  return q.module === value;
}
function matchesFacets(q, facets) {
  return Object.entries(facets).every(([name,value]) => !value || (name === 'year' ? q.years?.includes(Number(value)) : q[name] === value));
}
function selectOptions(items, value) {
  return items.map(([id,label]) => '<option value="' + esc(id) + '"' + (id === value ? ' selected' : '') +
    '>' + esc(label) + '</option>').join('');
}
function facetControls(p) {
  const topics = [...new Map(p.all.filter(q=>q.topicCode).map(q=>[q.topicCode,q.topic]))];
  const options = {
    source: ['来源', Object.entries(sources).filter(([id])=>p.all.some(q=>q.source===id))],
    topicCode: ['考点', topics],
    type: ['题型', [...Object.entries(kinds), ['reference','参考题'], ['reference-multiple','多选参考题']]
      .filter(([id])=>p.all.some(q=>q.type===id))],
    paper: ['范围', [...new Set(p.all.map(q=>q.paper).filter(Boolean))].map(paper=>[paper,paper])],
    year: ['年份', [...new Set(p.all.flatMap(q=>q.years||[]))].sort((a,b)=>b-a).map(year=>[String(year),year+' 年'])],
  };
  const filters = Object.entries(options).filter(([, [, items]])=>items.length>1 ||
    (items.length===1 && items[0][0] !== 'ai')).map(([name,[label,items]]) =>
    '<label>' + label + '<select aria-label="' + label + '" name="facet-' + name + '">' +
    selectOptions([['','全部' + label],...items],p.facets[name]) + '</select></label>');
  return filters.length ? '<div class="facets">' + filters.join('') + '</div>' : '';
}
function renderPractice() {
  const p = practice;
  const q = p.items[p.index];
  const filters = course.modules;
  const moduleList = [{name:'', label:'全部'}].concat(filters);
  const modules = moduleList.map(m =>
    action(esc(m.label || m.name) + '<span class="count">' +
      p.all.filter(item => matchesFilter(item,m.name) && matchesFacets(item,p.facets)).length + '</span>',
    'filter', {value:m.name,kind:p.filter===m.name?'chosen':''})).join('');
  const last = p.index + 1 === p.items.length;
  const codeReview = q?.type === 'code' && p.example && !p.result;
  const reference = codeReview ? '<div class="feedback"><strong>参考答案</strong><pre>' +
    esc(p.example.explanation) + '</pre></div>' : '';
  const submit = p.result ? '' : q?.type !== 'code' ? action('提交答案','answer',{kind:'primary',disabled:p.selected===null}) :
    codeReview ? action('自评正确','self-grade',{value:1,kind:'primary'}) + action('加入错题','self-grade',{value:0}) :
    action('完成作答，查看参考','example',{kind:'primary',disabled:!p.written.trim()});
  const inner = q ? question(q, p.index+1, p.items.length, p.selected, p.result, q.misses,p.written) +
    reference + '<div class="actions">' + submit +
    action('上一题','practice-prev',{kind:p.result?'':'push',disabled:p.index===0}) +
    ((!last || (page === 'review' && p.result)) ? action(last ? '更新错题列表' : '下一题','practice-next',{kind:p.result?'primary push':''}) : '') +
    '</div>' : '<div class="empty"><h2>' + (page === 'review' ? '这里暂时没有待复习的错题' : '这个模块暂时没有题目') +
    '</h2>' + (p.filter || Object.values(p.facets).some(Boolean) ? action('清除筛选','clear-filters') :
      '<a href="' + link(course.id,'bank') + '">进入题库</a>') + '</div>';
  show(facetControls(p) + '<div class="workbench"><aside class="panel side modules" aria-label="模块">' + modules +
    '</aside><section class="panel question">' + inner + '</section></div>');
}
function resetPractice(position) {
  Object.assign(practice, {index:position, selected:null, result:null, request:null, written:'', example:null});
  renderPractice();
}
function filterPractice() {
  practice.items = practice.all.filter(q => matchesFilter(q,practice.filter) && matchesFacets(q,practice.facets));
  resetPractice(0);
}
async function loadExams(version) {
  const data = await api('exams' + args({course:course.id}));
  if (version !== epoch) return;
  history = data.history;
  exam = data.active;
  index = exam ? Math.max(0,exam.questions.findIndex(q => !(q.id in exam.answers))) : 0;
  if (exam) renderExam(); else setupExam();
}
function setupExam() {
  const kindsAvailable = Object.entries(kinds).filter(([id])=>course.modules.some(m=>m.examKinds[id]));
  show('<div class="exam-grid"><section class="panel"><h2>设置题量</h2><form id="exam-config">' +
    '<label class="written-label">抽题题型<select aria-label="抽题题型" name="exam-kind">' +
    selectOptions([['objective','全部客观题'],['all','全部题型（含大题）'],...kindsAvailable],'objective') +
    '</select></label><div id="exam-counts"></div>' +
    '<p class="config-total">共 <strong id="total">20</strong> 题</p><button class="primary">开始考试</button></form></section>' +
    '<section class="panel"><h2>考试历史</h2><div class="history">' +
    (history.length ? history.map(h => action('<span>' + esc(date(h.finished)) + '</span><strong>' +
      (h.pending ? h.pending + ' 道待自评' : h.correct + ' / ' + h.total) +
      '</strong>','open-history',{value:h.id})).join('') : '<p class="muted">暂无已交卷的考试。</p>') +
    '</div></section></div>');
  updateExamCounts('objective');
}
function updateExamCounts(kind) {
  const rows = course.modules.map(m=>[m,kind === 'objective' ? m.examSize :
    kind === 'all' ? m.examSize+m.examKinds.code : m.examKinds[kind]]).filter(([,size])=>size).map(([m,size],i) =>
    '<label class="config-row" for="count' + i + '"><span>' + esc(m.name) + '<small>' +
    (m.weight ? m.weight + '% · ' : '') + '可选 ' + size + ' 题</small></span>' +
    '<input type="number" id="count' + i + '" name="' + esc(m.name) + '" min="0" max="' + size +
    '" step="1" value="' + Math.min(size,m.weight/5) + '" required></label>').join('');
  document.querySelector('#exam-counts').innerHTML = rows;
  configTotal();
}
function configTotal() {
  const form = document.querySelector('#exam-config');
  if (!form) return;
  const fields = [...form.querySelectorAll('input')];
  const total = fields.reduce((sum, input) => sum + (input.valueAsNumber || 0),0);
  document.querySelector('#total').textContent = total;
  form.querySelector('button').disabled = total <= 0 || fields.some(input => !input.validity.valid);
}
function renderExam() {
  const q = exam.questions[index];
  const total = exam.questions.length;
  const count = Object.keys(exam.answers).length;
  const markers = exam.questions.map((item,i) => {
    const grade = item.type === 'code' ? exam.grades?.[item.id] : exam.answers[item.id] === item.correct ? 1 : 0;
    const status = exam.finished && grade === undefined ? 'pending' : exam.finished && grade === 0 ? 'miss' :
      item.id in exam.answers ? 'answered' : '';
    return '<button type="button" data-action="jump" data-value="' + i + '" class="' + status +
      '" aria-label="第 ' + (i+1) + ' 题' + (status==='pending'?'，待自评':status==='miss'?'，答错':status?'，已答':'，未答') +
      '"' + (index===i?' aria-current="step"':'') + '>' + (i+1) + '</button>';
  }).join('');
  const side = exam.finished ? (exam.pending ? '<h2>大题待自评</h2><p>还有 ' + exam.pending + ' 道大题待自评</p>' :
    '<h2>考试成绩</h2><p><strong>' + percent(exam.correct,total) + ' 分</strong> · 答对 ' + exam.correct + ' / ' + total + '</p>') :
    '<h2>答题卡</h2><p class="muted">已答 ' + count + ' / ' + total + '</p>';
  const needsGrade = exam.finished && q.type === 'code' && exam.grades[q.id] === undefined;
  const footer = exam.finished ? (needsGrade ? action('自评正确','grade-exam',{value:1,kind:'primary'}) +
    action('加入错题','grade-exam',{value:0}) : '') + action('返回考试历史','exam-back') :
    action('放弃本场','exam-discard') + action('交卷','exam-finish',{kind:'primary push',disabled:count<total});
  show('<div class="workbench"><aside class="panel exam-side">' + side + '<div class="numbers">' + markers +
    '</div></aside><section class="panel question">' + question(q,index+1,total,
      q.type === 'code' ? exam.grades?.[q.id] : exam.answers[q.id],exam.finished?q:null,0,exam.answers[q.id]) +
    '<div class="actions">' + action('上一题','jump',{value:index-1,disabled:index===0}) +
    action('下一题','jump',{value:index+1,disabled:index+1===total}) + footer + '</div></section></div>');
}
async function change(actionFn) {
  if (busy) return;
  const version = epoch;
  busy = true;
  app.setAttribute('aria-busy','true');
  try { await actionFn(() => version===epoch); }
  catch (error) { if (version===epoch) alertUser(error.message); }
  finally { if (version===epoch) { busy=false; app.setAttribute('aria-busy','false'); } }
}
function requestId() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), x => x.toString(36)).join('-');
}
app.addEventListener('input', event => {
  if (event.target.form?.id==='exam-config') configTotal();
  if (page === 'exam' || busy) return;
  if (event.target.name === 'written') {
    practice.written = event.target.value;
    app.querySelector('[data-action="example"]').disabled = !practice.written.trim();
  }
  if (event.target.name === 'number') {
    practice.selected = numericAnswer(event.target.value);
    practice.request = null;
    app.querySelector('[data-action="answer"]').disabled = practice.selected === null;
  }
});
function numericAnswer(text) {
  return /^\d+$/.test(text) && Number(text) <= 1000000000 ? Number(text) : null;
}
app.addEventListener('change', event => {
  const option = event.target;
  if (option.name === 'exam-kind') return updateExamCounts(option.value);
  if (option.name?.startsWith('facet-')) {
    practice.facets[option.name.slice(6)] = option.value;
    if (option.name === 'facet-topicCode' && option.value) practice.filter = '';
    return filterPractice();
  }
  if (option.name !== 'answer' && !(page === 'exam' && ['number','exam-written'].includes(option.name))) return;
  const selected = option.name === 'exam-written' ? option.value : option.name === 'number' ? numericAnswer(option.value) : option.type === 'checkbox' ?
    [...app.querySelectorAll('input[name=answer]:checked')].reduce((mask, input) => mask | (1 << Number(input.value)),0) :
    Number(option.value);
  if (page !== 'exam') {
    if (busy) return;
    practice.selected = option.type === 'checkbox' && !selected ? null : selected;
    practice.request = null;
    app.querySelector('[data-action="answer"]').disabled = practice.selected === null;
    return;
  }
  if (option.name === 'number' && option.value.trim() && selected === null) {
    alertUser('请输入 0 至 1000000000 的整数。');
    return renderExam();
  }
  if (busy) return renderExam();
  const oldIndex = index;
  change(async current => {
    try {
      const result = await api('exam/save',{course:course.id,id:exam.id,question:exam.questions[oldIndex].id,selected});
      if (current()) { exam=result; renderExam(); }
    } catch (error) {
      if (current()) renderExam();
      throw error;
    }
  });
});
app.addEventListener('submit', event => {
  if (event.target.id !== 'exam-config') return;
  event.preventDefault();
  if (!event.target.reportValidity()) return;
  const form = new FormData(event.target);
  const kind = form.get('exam-kind');
  form.delete('exam-kind');
  const counts = Object.fromEntries([...form].map(([name,count]) => [name,Number(count)]));
  change(async current => {
    const result = await api('exam/start',{course:course.id,counts,kind});
    if (current()) { exam=result; index=0; renderExam(); }
  });
});
app.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || busy) return;
  const {action:id,value} = button.dataset;
  if (id === 'reload' || id === 'exam-back') return navigate();
  if (id === 'filter') {
    practice.filter = value;
    return filterPractice();
  }
  if (id === 'clear-filters') {
    practice.filter='';
    practice.facets={source:'',topicCode:'',type:''};
    return filterPractice();
  }
  if (id === 'practice-prev') return resetPractice(practice.index-1);
  if (id === 'practice-next') {
    return practice.index+1 < practice.items.length ? resetPractice(practice.index+1) : navigate();
  }
  if (id === 'example') {
    return change(async current => {
      const result = await api('answer/example',{course:course.id,id:practice.items[practice.index].id});
      if (current()) { practice.example=result; renderPractice(); }
    });
  }
  if (id === 'answer' || id === 'self-grade') {
    return change(async current => {
      const p = practice;
      if (id === 'self-grade') {
        if (p.selected !== Number(value)) p.request = null;
        p.selected = Number(value);
      }
      p.request ||= requestId();
      const result = await api('answer',{course:course.id,id:p.items[p.index].id,selected:p.selected,mode:page,
        request:p.request,response:id === 'self-grade' ? p.written : undefined});
      if (current()) { p.result=result; renderPractice(); }
    });
  }
  if (id === 'jump') { index=Number(value); return renderExam(); }
  if (id === 'open-history') {
    return change(async current => {
      const result = await api('exam' + args({course:course.id,id:value}));
      if (current()) {
        exam=result;
        index=exam.pending ? exam.questions.findIndex(q=>q.type==='code' && exam.grades[q.id]===undefined) : 0;
        renderExam();
      }
    });
  }
  if (id === 'exam-finish') {
    return change(async current => {
      const result = await api('exam/finish',{course:course.id,id:exam.id});
      if (current()) { exam=result; index=exam.pending ? exam.questions.findIndex(q=>q.type==='code') : 0; renderExam(); }
    });
  }
  if (id === 'grade-exam') {
    return change(async current => {
      const result = await api('exam/grade',{course:course.id,id:exam.id,
        question:exam.questions[index].id,selected:Number(value)});
      if (current()) { exam=result; renderExam(); }
    });
  }
  if (id === 'exam-discard' && confirm('放弃本场考试并清除本场未交卷答案？')) {
    return change(async current => {
      await api('exam/discard',{course:course.id,id:exam.id});
      if (current()) await navigate();
    });
  }
});
window.addEventListener('hashchange',navigate);
navigate();
