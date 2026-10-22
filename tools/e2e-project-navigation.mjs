#!/usr/bin/env node
/**
 * 项目树 / 续挑 / 已看进度 / 保存失败重试的浏览器回归。
 * 先 cd web && VITE_API_BASE=/api/v1 npm run build，再从仓库根运行 node tools/e2e-project-navigation.mjs。
 * 独立临时库（205 张 + 第二项目 + UI新建项目），不读写用户照片；CDP 真鼠标/键盘，不用深链代替点击。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const FILE = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(FILE), '..');
const SHOT = join(REPO, 'tools/shot.mjs');

export default async function probe(send) {
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const addPath = await evaluate(`new URLSearchParams(location.search).get('testAddPath')`);
  assert.ok(addPath, '缺少隔离的新建项目目录');
  const waitFor = async (expression, message) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await sleep(100);
    }
    throw new Error(`${message}\n${await evaluate(`JSON.stringify({ url:location.href, project:document.querySelector('[data-current-project]')?.textContent, photo:document.querySelector('[data-current-photo]')?.textContent, search:document.querySelector('[data-search-results]')?.textContent, activePhotos:[...document.querySelectorAll('[data-tree-photo][data-active="true"]')].map(e => e.textContent) })`)}`);
  };
  const click = async (selector) => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('missing '+${JSON.stringify(selector)});
      element.scrollIntoView({block:'center'});
      const rect = element.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const clickText = async (text) => {
    const selector = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(text)});
      if (!button) throw new Error('missing button '+${JSON.stringify(text)});
      button.dataset.navigationTestButton = 'target';
      return '[data-navigation-test-button="target"]';
    })()`);
    try { await click(selector); }
    finally { await evaluate(`document.querySelector(${JSON.stringify(selector)})?.removeAttribute('data-navigation-test-button')`); }
  };
  const rate = async (stars) => {
    await click('[data-deck-card]');
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: String(stars), code: `Digit${stars}`, windowsVirtualKeyCode: 48 + stars });
    }
  };
  const reloadPage = async (acceptBeforeUnload = false) => {
    await evaluate('window.__navigationBeforeReload = true');
    const reloading = send('Page.reload', { ignoreCache:true });
    if (acceptBeforeUnload) {
      // Dirty edits trigger the native beforeunload dialog; accept it without removing the guard.
      let accepted = false;
      for (let i = 0; i < 150; i++) {
        try { await send('Page.handleJavaScriptDialog', { accept:true }); accepted = true; break; }
        catch (error) { if (!/No dialog is showing/i.test(String(error))) throw error; }
        await sleep(100);
      }
      assert.ok(accepted, '未保存标记刷新应提示beforeunload确认');
    }
    await reloading;
    for (let i = 0; i < 150; i++) {
      try { if (await evaluate('!window.__navigationBeforeReload && document.readyState === "complete"')) return; }
      catch (error) {
        if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(String(error))) throw error;
      }
      await sleep(100);
    }
    throw new Error('Page.reload未完成');
  };
  const failMarks = () => evaluate(`(() => {
    window.__navigationFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method.toUpperCase() === 'PUT' && url.pathname === '/api/v1/marks') return Promise.reject(new Error('navigation regression: simulated marks outage'));
      return window.__navigationFetch.call(this, input, init);
    };
  })()`);
  const restoreFetch = () => evaluate('window.fetch = window.__navigationFetch; delete window.__navigationFetch');
  const pending = () => evaluate(`JSON.parse(localStorage.getItem('artworks:cull-session:v1')).pending`);
  const modeIs = (label) => `document.querySelector('[aria-label="${label}"]')?.getAttribute('data-state') === 'on'`;
  // Include both projects and the deleted stream: unrelated writes must not hide in a filter.
  const marks = () => evaluate(`Promise.all(['/nav', '/other'].flatMap(dir => [false, true].map(del =>
    fetch('/api/v1/photos?recursive=1&limit=1000&dir='+encodeURIComponent(dir)+(del ? '&sel=del' : ''))
      .then(r => { if (!r.ok) throw new Error('marks read failed'); return r.json(); })
      .then(d => d.items.map(p => ({ id:p.id, stars:p.stars, del:Boolean(p.del) })))
  ))).then(groups => groups.flat().sort((a,b) => a.id.localeCompare(b.id)))`);
  const seenCount = () => evaluate(`Number(document.querySelector('[data-seen-progress]')?.textContent.match(/已看 (\\d+) /)?.[1])`);
  const expectProjectProgress = async (path, seen, total) => {
    const selector = `[data-project-progress="${path}"]`;
    const text = `已看 ${seen} / ${total}`;
    await waitFor(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)}) &&
      document.querySelector(${JSON.stringify(selector + ' [role="progressbar"]')})?.getAttribute('aria-valuetext') === ${JSON.stringify(text)}`,
    `${path}项目进度应为${text}（递归且含待删）`);
  };
  const project = (path) => `[data-folder-path="${path}"]`;
  const current = (name) => `document.querySelector('[data-current-photo]')?.textContent === ${JSON.stringify(name)}`;
  const photoId = async (name) => evaluate(`(() => {
    const node=[...document.querySelectorAll('[data-tree-photo]')].find(e=>e.textContent.startsWith(${JSON.stringify(name)}));
    if(!node) throw new Error('missing photo '+${JSON.stringify(name)});
    return node.dataset.treePhoto;
  })()`);

  await waitFor(`document.querySelector(${JSON.stringify(project('/nav'))})`, '项目未载入');
  await waitFor(current('OTHER'), '启动URL应先载入第二项目，不能被默认项目覆盖');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('dir')`), '/other');
  await click(project('/nav'));
  await waitFor(current('P001'), '点击项目未显示第一张照片');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('dir')`), '/nav');
  assert.equal(await evaluate(`document.querySelector('[data-current-project]')?.textContent`), '项目：导航测试');
  console.log('ok 点项目 → 整组挑片，顶栏显示项目');

  await expectProjectProgress('/nav', 0, 205);
  await expectProjectProgress('/other', 0, 1);
  const baselineMarks = await marks();
  assert.equal(await seenCount(), 0, '仅打开项目不能增加已看');
  // Auto-reveal already opens this folder; never blindly toggle it closed.
  await waitFor(`document.querySelector('[data-folder-toggle="/nav/相册"]')`, '照片目录未出现');
  if (await evaluate(`document.querySelector('[data-folder-toggle="/nav/相册"]').getAttribute('aria-expanded') !== 'true'`)) {
    await click('[data-folder-toggle="/nav/相册"]');
  }
  await waitFor(`[...document.querySelectorAll('[data-tree-photo]')].some(e => e.textContent.startsWith('P001'))`, '首张照片未显示在树中');
  const first = await photoId('P001');
  await click('[data-folder-toggle="/nav/相册"]'); // deliberately collapse before advancing
  await clickText('下一张');
  await waitFor(current('P002'), '下一张未前进');
  await waitFor(`document.querySelector('[data-folder-toggle="/nav/相册"]')?.getAttribute('aria-expanded') === 'true' &&
    [...document.querySelectorAll('[data-tree-photo][data-active="true"][aria-current="true"]')].some(e => e.textContent.startsWith('P002'))`, '当前照片未自动展开/高亮');
  assert.equal(await seenCount(), 1, '主动翻过应记一张已看');
  await expectProjectProgress('/nav', 1, 205);
  await expectProjectProgress('/other', 0, 1);
  await waitFor(`document.querySelector('[data-tree-photo="${first}"] [aria-label="已看"]')`, '已翻过照片未显示已看标记');
  const second = await photoId('P002');
  assert.equal(await evaluate(`document.querySelector('[data-tree-photo="${second}"] [aria-label="未看"]') !== null`), true, '刚打开的下一张不算已看');
  await clickText('上一张');
  await waitFor(current('P001'), '上一张未返回');
  await sleep(600); // catch accidental debounced rating writes, not just optimistic UI
  assert.deepEqual(await marks(), baselineMarks, '上一张/下一张不能改变星级或待删');
  console.log('ok 主动翻页记已看但不打星；当前文件自动展开并高亮');

  const fileCount = `[...document.querySelectorAll('[data-tree-photo]')].filter(e=>e.textContent.startsWith('P')).length`;
  await waitFor(`${fileCount} === 101`, '目录首批应为100张普通照片+1张待删');
  await click('[data-tree-more="/nav/相册"]');
  await waitFor(`${fileCount} === 201`, '文件树第二页未载入');
  await click('[data-tree-more="/nav/相册"]');
  await waitFor(`${fileCount} === 205`, '文件树末页未载入');
  console.log('ok 文件树按目录分页，待删照片也可见（205项）');

  const last = await photoId('P204');
  await click(`[data-tree-photo="${last}"]`);
  await waitFor(current('P204'), '第204张定位失败');
  assert.equal(await evaluate(`document.querySelector('[data-deck-card] img')?.alt`), 'P204');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('dir')`), '/nav');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`[data-tree-photo="${last}"]`)})?.getAttribute('data-active')`), 'true');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(project('/nav'))})?.getAttribute('data-active')`), 'true');
  console.log('ok 跨挑片分页定位第204张，保留项目范围，项目/照片同时高亮');

  const deleted = await photoId('P205');
  await click(`[data-tree-photo="${deleted}"]`);
  await waitFor(current('P205'), '待删照片定位失败');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('sel')`), 'del');
  console.log('ok 点待删照片 → 待删视图定位，不修改标记');

  await click(`[data-tree-photo="${last}"]`);
  await waitFor(current('P204'), '从待删返回普通照片失败');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('sel')`), null);
  // 鼠标回到照片舞台，避免把快捷键发给仍持有焦点的文件树按钮。
  // 400ms 保存计时器还没触发就切到另一项目，必须保存旧项目的标记。
  await rate(3);
  await click(project('/other'));
  await waitFor(current('OTHER'), '切换第二项目失败');
  const stars = await evaluate(`fetch('/api/v1/photos?dir=/nav&recursive=1&limit=1000').then(r=>r.json()).then(d=>d.items.find(p=>p.id===${JSON.stringify(last)})?.stars)`);
  assert.equal(stars, 3, '快速切项目丢失标记');
  console.log('ok 打标后立即切项目，原照片3星落盘');

  // 不等第一项请求完成，马上切到另一项。
  await click(project('/nav'));
  await click(project('/other'));
  await waitFor(current('OTHER'), '快速切换最后一次导航未生效');
  await sleep(500);
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('dir')`), '/other');
  assert.equal(await evaluate(`document.querySelector('[data-current-project]')?.textContent`), '项目：第二项目');
  console.log('ok 快速切换项目后，最后点击的项目保持生效');

  await click(project('/nav'));
  await waitFor(current('P204'), '返回项目应续挑P204，而不是重置到P001');
  await waitFor(`document.querySelector('[data-tree-photo="${last}"]')?.textContent.includes('★3')`, '文件树未显示已保存的3星');
  console.log('ok 返回项目恢复P204；文件树显示星级');

  const beforeFilters = await marks();
  // Search rows must be scoped: the expanded directory contains nonmatching photos too.
  const filters = {
    seen: '筛选已看状态', rating: '筛选星级', deletion: '筛选待删状态', kind: '筛选文件类型',
  };
  const selectFilter = async (key, value) => {
    await evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(`select[aria-label="${filters[key]}"]`)});
      if (![...select.options].some(option => option.value === ${JSON.stringify(value)})) throw new Error('missing filter option');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles:true }));
    })()`);
  };
  const searchFilename = async (value) => evaluate(`(() => {
    const input = document.querySelector('input[aria-label="搜索当前项目文件名"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles:true }));
  })()`);
  const searchRows = `[...document.querySelectorAll('[data-search-results] [data-tree-photo]')]`;
  const expectSearch = async (count, names) => {
    await waitFor(`document.querySelector('[data-search-results]')?.querySelector('[role="status"]')?.textContent === '找到 ${count} 项' &&
      ${searchRows}.length === ${Math.min(count, 100)}`, `筛选结果应有${count}项`);
    if (names) assert.deepEqual(await evaluate(`${searchRows}.map(e => e.textContent.match(/^P\\d{3}/)?.[0])`), names);
    assert.equal(await evaluate(`${searchRows}.some(e => e.textContent.startsWith('OTHER'))`), false, '筛选不得跨项目');
  };
  const resetSearch = async () => {
    await clickText('重置筛选');
    await waitFor(`!document.querySelector('[data-search-results]') &&
      document.querySelector('input[aria-label="搜索当前项目文件名"]').value === '' &&
      ${JSON.stringify(Object.values(filters))}.every(label => document.querySelector('select[aria-label="'+label+'"]').value === 'all')`,
    '无文件名时重置应恢复全部筛选并退出搜索');
  };
  for (const [key, values] of Object.entries({
    seen: ['all', 'unseen', 'seen'], rating: ['all', 'starred', '0', '1', '2', '3', '4', '5'],
    deletion: ['all', 'normal', 'deleted'], kind: ['all', 'photo', 'video'],
  })) {
    assert.deepEqual(await evaluate(`[...document.querySelector(${JSON.stringify(`select[aria-label="${filters[key]}"]`)}).options].map(o => o.value)`), values);
  }
  // At this point P001/P002 were advanced past and P204 was rated; opening alone is not seen.
  for (const [key, value, count, names] of [
    ['seen', 'seen', 3, ['P001', 'P002', 'P204']], ['seen', 'unseen', 202],
    ['rating', 'starred', 1, ['P204']], ['rating', '0', 204],
    ...[1, 2, 3, 4, 5].map(stars => ['rating', String(stars), stars === 3 ? 1 : 0, stars === 3 ? ['P204'] : []]),
    ['deletion', 'normal', 204], ['deletion', 'deleted', 1, ['P205']],
    ['kind', 'photo', 205], ['kind', 'video', 0, []],
  ]) {
    await selectFilter(key, value);
    await expectSearch(count, names);
    await resetSearch();
  }
  await selectFilter('seen', 'seen');
  await selectFilter('rating', '3');
  await selectFilter('deletion', 'normal');
  await selectFilter('kind', 'photo');
  await expectSearch(1, ['P204']);
  await selectFilter('deletion', 'deleted');
  await expectSearch(0, []);
  await selectFilter('seen', 'unseen');
  await selectFilter('rating', '0');
  await expectSearch(1, ['P205']);
  await searchFilename('P204');
  await expectSearch(0, []);
  await searchFilename('P205');
  await expectSearch(1, ['P205']);
  await expectProjectProgress('/nav', 3, 205); // Project totals must not shrink with filters.
  await expectProjectProgress('/other', 0, 1);
  await clickText('重置筛选');
  await expectSearch(1, ['P205']);
  assert.equal(await evaluate(`document.querySelector('input[aria-label="搜索当前项目文件名"]').value`), 'P205', '重置筛选应保留文件名');
  for (const label of Object.values(filters)) {
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`select[aria-label="${label}"]`)}).value`), 'all');
  }
  await click('[aria-label="清除文件搜索"]');
  await waitFor(`!document.querySelector('[data-search-results]')`, '清除文件名后应退出搜索');
  assert.deepEqual(await marks(), beforeFilters, '读取筛选结果不能修改标记');
  await waitFor(current('P204'), '筛选或重置不能改变当前照片');
  console.log('ok 无文件名筛选、全部选项、组合/空结果、文件名+筛选及重置；项目进度不受筛选影响');

  // Collapse the ordinary listing so the clicked P203 can only be a search result.
  if (await evaluate(`document.querySelector('[data-folder-toggle="/nav/相册"]')?.getAttribute('aria-expanded') === 'true'`)) {
    await click('[data-folder-toggle="/nav/相册"]');
  }
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="搜索当前项目文件名"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'P203');
    input.dispatchEvent(new Event('input', { bubbles:true }));
  })()`);
  await waitFor(`[...document.querySelectorAll('[data-search-results] [data-tree-photo]')].some(e => e.textContent.startsWith('P203'))`, '项目搜索未找到跨页文件P203');
  const searched = await photoId('P203');
  await click(`[data-search-results] [data-tree-photo="${searched}"]`);
  await waitFor(current('P203'), '点击搜索结果未定位');
  await click('[aria-label="清除文件搜索"]');
  await waitFor(`document.querySelector('[data-tree-photo="${searched}"][data-active="true"]')`, '搜索定位后文件树未自动揭示当前照片');
  await click(project('/other'));
  await waitFor(current('OTHER'), '搜索后切换项目失败');
  await click(project('/nav'));
  await waitFor(current('P203'), '项目未恢复搜索选中的文件');
  console.log('ok 输入搜索、点击结果与跨项目续挑');

  await click('[aria-label="批量扫"]');
  await waitFor(`document.querySelector('[aria-label="批量扫"]')?.getAttribute('data-state') === 'on'`, '切换批量模式失败');
  await click(project('/other'));
  await waitFor(current('OTHER'), '模式测试切换第二项目失败');
  await waitFor(modeIs('一个看'), '第二项目应保持单张模式，不能继承第一项目的批量模式');
  await click(project('/nav'));
  await waitFor(`${current('P203')} && ${modeIs('批量扫')}`, 'A批量→B单张→A未恢复独立模式');
  console.log('ok A批量 / B单张的项目模式独立保存，A→B→A恢复');
  // Remove the mode deep link: reload must prove session restoration, not URL parsing.
  await evaluate(`(() => { const url=new URL(location.href); url.searchParams.delete('mode'); history.replaceState(null, '', url); })()`);
  await reloadPage();
  await waitFor(`!window.__navigationBeforeReload && document.readyState === 'complete' && ${current('P203')} &&
    document.querySelector('[aria-label="批量扫"]')?.getAttribute('data-state') === 'on'`, '刷新未恢复照片和批量模式');
  await click('[aria-label="一个看"]');
  await waitFor(`document.querySelector('[data-deck-card] img')?.alt === 'P203'`, '切回单张模式失败');
  console.log('ok Page.reload恢复文件和本机挑片模式（无mode深链）');

  const beforeFailure = await marks();
  await failMarks();
  try {
    await rate(4);
    await click(project('/other')); // flushSave fails during the switch, not only the debounce.
    await waitFor(current('OTHER'), '保存失败不能阻止目标项目载入');
    await waitFor(`document.querySelector('[data-save-status="error"]')?.textContent.includes('重试保存')`, '保存失败未显示错误和重试');
    assert.deepEqual(await marks(), beforeFailure, '模拟失败时不应有标记落盘');
    assert.deepEqual((await pending())[searched], { stars:4, del:false }, '切项目保存失败必须保留dirty备份');
    await click(project('/nav'));
    await waitFor(current('P203'), '保存失败后应能返回原项目');
    await waitFor(`document.querySelector('[data-tree-photo="${searched}"]')?.textContent.includes('★4')`, '返回项目必须保留未保存的4星');
    await clickText('下一张');
    await waitFor(current('P204'), '保存失败后仍应可浏览');
  } finally {
    await restoreFetch();
  }
  await clickText('重试保存');
  await waitFor(`document.querySelector('[data-save-status="saved"]')`, '重试未显示已保存');
  let expectedMarks = beforeFailure.map(mark => mark.id === searched ? { ...mark, stars:4, del:false } : mark);
  assert.deepEqual(await marks(), expectedMarks, '重试应保存P203的4星，不能误标当前P204或其他照片');
  await clickText('上一张');
  await waitFor(current('P203'), '重试后返回目标照片失败');
  await waitFor(`document.querySelector('[data-tree-photo="${searched}"]')?.textContent.includes('★4')`, '重试后文件树未显示4星');
  assert.deepEqual(await pending(), {}, '重试成功应清空dirty备份');
  console.log('ok PUT /marks模拟断网→切项目仍载入→dirty保留→切图重试，仅目标保存');

  await failMarks();
  try {
    await rate(5);
    await waitFor(`document.querySelector('[data-save-status="error"]')`, '刷新测试未进入模拟保存失败');
    assert.deepEqual((await pending())[searched], { stars:5, del:false }, '刷新前必须持久备份未保存的5星');
    assert.deepEqual(await marks(), expectedMarks, '刷新前失败的5星不应落盘');
    await reloadPage(true); // A real document reload removes the fetch mock; boot should naturally retry.
  } finally {
    if (await evaluate('Boolean(window.__navigationFetch)')) await restoreFetch();
  }
  await waitFor(current('P203'), '失败后刷新未恢复原照片');
  await waitFor(`document.querySelector('[data-save-status="saved"]')`, '刷新后未自动重试保存pending');
  expectedMarks = expectedMarks.map(mark => mark.id === searched ? { ...mark, stars:5 } : mark);
  assert.deepEqual(await marks(), expectedMarks, '刷新必须恢复并保存5星，不能丢失或误写其他照片');
  assert.deepEqual(await pending(), {}, '刷新自动重试成功应清空pending');
  console.log('ok 模拟保存失败→Page.reload移除mock→pending自动重试落盘');

  // Make a non-contiguous seen island: P001/P002 were seen above; P003 is unseen.
  const fourth = await photoId('P004');
  await click(`[data-tree-photo="${fourth}"]`);
  await waitFor(current('P004'), '未看测试定位P004失败');
  await clickText('下一张');
  await waitFor(current('P005'), '未看测试标记P004已看失败');
  await clickText('继续未看过');
  await waitFor(current('P003'), '继续未看过应定位第一张未看P003');
  const third = await photoId('P003');
  const fifth = await photoId('P005');
  await clickText('下一张');
  await waitFor(current('P005'), '未看模式下一张必须跳过已看P004');
  await click('[aria-label="批量扫"]');
  await waitFor(modeIs('批量扫'), '未看模式切批量失败');
  await waitFor(`document.querySelector('[data-photo="${fifth}"]')`, '未看P005应保留在网格');
  for (const id of [first, second, third, fourth]) {
    assert.equal(await evaluate(`document.querySelector('[data-photo="${id}"]') === null`), true, '未看网格必须隐藏已看照片 '+id);
  }
  assert.deepEqual(await marks(), expectedMarks, '继续未看/跳过已看/过滤网格不能改变标记');
  console.log('ok 继续未看过定位首张未看，下一张跳过已看，批量网格隐藏已看');

  assert.ok(await seenCount() > 0, '重置前应有已看进度');
  // The probe only receives send(), not CDP event subscriptions; acknowledge the native confirm explicitly.
  await evaluate(`window.__navigationConfirm=window.confirm; window.confirm=() => { window.__navigationConfirmed=true; return true; }`);
  try {
    await clickText('重置已看进度');
    assert.equal(await evaluate('window.__navigationConfirmed'), true, '重置必须请求确认');
    await waitFor(`document.querySelector('[data-seen-progress]')?.textContent.includes('已看 0 /')`, '已看进度未清零');
  } finally {
    await evaluate(`window.confirm=window.__navigationConfirm; delete window.__navigationConfirm; delete window.__navigationConfirmed`);
  }
  for (const id of [first, second, third, fourth]) {
    await waitFor(`document.querySelector('[data-photo="${id}"]')`, '重置后已看照片应重新出现在网格 '+id);
  }
  await expectProjectProgress('/nav', 0, 205);
  await expectProjectProgress('/other', 0, 1);
  assert.deepEqual(await marks(), expectedMarks, '重置已看不能改变星级或待删');
  console.log('ok 确认重置本项目已看进度，标记保持不变');

  // SIMULATED XMP fallback: persist through the real server, alter only the response warning.
  await click(`[data-tree-photo="${fifth}"]`);
  await waitFor(`${current('P005')} && ${modeIs('一个看')}`, '模拟XMP警告前定位失败');
  await evaluate(`(() => {
    window.__navigationFetch = window.fetch;
    window.fetch = async function(input, init) {
      const response = await window.__navigationFetch.call(this, input, init);
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method.toUpperCase() !== 'PUT' || url.pathname !== '/api/v1/marks' || !response.ok) return response;
      const body = await response.json();
      body.results = body.results.map(result => result.ok ? { ...result, error:'SIMULATED XMP write-back failure' } : result);
      return new Response(JSON.stringify(body), { status:response.status, statusText:response.statusText, headers:response.headers });
    };
  })()`);
  try {
    await rate(2);
    await waitFor(`document.querySelector('[data-save-status="warning"]')?.textContent.includes('应用标记已保存，XMP 未写回') &&
      document.querySelector('[data-save-status="warning"]')?.textContent.includes('SIMULATED XMP write-back failure')`, '模拟XMP回退未显示应用已保存但XMP未写回警告');
    expectedMarks = expectedMarks.map(mark => mark.id === fifth ? { ...mark, stars:2 } : mark);
    assert.deepEqual(await marks(), expectedMarks, '模拟XMP警告仍须真实保存目标标记');
    assert.deepEqual(await pending(), {}, '应用保存成功的XMP警告不应保留dirty');
  } finally {
    await restoreFetch();
  }
  console.log('ok SIMULATED XMP警告：真实PUT落盘，仅响应注入XMP失败，UI明确区分');

  // Layout is presentation-only; keep this after the original navigation/marks scenarios.
  const layoutGroup = '[role="group"][aria-label="项目文件显示方式"]';
  const layoutIs = (label) => `[...document.querySelectorAll('${layoutGroup} button')].some(e =>
    e.textContent.trim() === ${JSON.stringify(label)} && e.getAttribute('aria-pressed') === 'true')`;
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('${layoutGroup} button')].map(e => e.textContent.trim())`), ['目录树', '全部文件']);
  await waitFor(layoutIs('目录树'), '默认布局应为目录树');
  const beforeLayout = await marks();
  const layoutPosition = await evaluate(`({ url:location.href, photo:document.querySelector('[data-current-photo]')?.textContent })`);
  const layoutSeen = await seenCount();
  // Observe real requests without mocking data: exhausted deleted pages must not be fetched again.
  await evaluate(`(() => {
    window.__navigationFetch = window.fetch;
    window.__navigationLayoutRequests = [];
    window.fetch = function(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname === '/api/v1/photos' && url.searchParams.get('dir') === '/nav' && url.searchParams.get('limit') === '100') {
        window.__navigationLayoutRequests.push(Object.fromEntries(url.searchParams));
      }
      return window.__navigationFetch.call(this, input, init);
    };
  })()`);
  try {
    await clickText('全部文件');
    await waitFor(`${layoutIs('全部文件')} && ${fileCount} === 101`, '全部文件首批应递归显示100张普通照片+1张待删');
    assert.equal(await evaluate(`document.querySelector('[data-folder-path="/nav/相册"], [data-folder-toggle="/nav/相册"]') === null`), true, '平铺模式必须隐藏子目录');
    assert.equal(await evaluate(`document.querySelector('${project('/nav')}') !== null`), true, '平铺模式必须保留项目根');
    assert.deepEqual(await evaluate(`({ url:location.href, photo:document.querySelector('[data-current-photo]')?.textContent })`), layoutPosition, '切换布局不能改变当前照片或导航位置');
    assert.equal(await seenCount(), layoutSeen, '切换布局不能增加已看');
    await waitFor(`document.querySelector('[data-tree-more="/nav"]:not([disabled])')`, '平铺分页入口应属于项目根');
    await click('[data-tree-more="/nav"]');
    await waitFor(`${fileCount} === 201 && document.querySelector('[data-tree-more="/nav"]:not([disabled])')`, '平铺第二页应显示200张普通照片+1张待删');
    await click('[data-tree-more="/nav"]');
    await waitFor(`${fileCount} === 205 && !document.querySelector('[data-tree-more="/nav"]')`, '平铺末页应显示205项并移除分页入口');
    const requests = await evaluate('window.__navigationLayoutRequests');
    assert.equal(requests.length, 4, '普通照片应请求3页，已耗尽的待删流仅请求1页');
    assert.ok(requests.every(request => request.recursive === '1'), '平铺必须递归请求项目文件');
    const normalPages = requests.filter(request => request.sel !== 'del');
    const deletedPages = requests.filter(request => request.sel === 'del');
    assert.equal(normalPages.length, 3);
    assert.equal(deletedPages.length, 1);
    assert.ok(!normalPages[0].cursor && !deletedPages[0].cursor, '普通/待删流应分别从首页开始');
    assert.ok(normalPages[1].cursor && normalPages[2].cursor && normalPages[1].cursor !== normalPages[2].cursor, '普通流应使用独立的后续游标');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-tree-photo]')].filter(e => e.textContent.startsWith('P')).map(e => e.textContent.slice(0, 4))`),
      Array.from({ length:205 }, (_, i) => `P${String(i + 1).padStart(3, '0')}`), '递归平铺不能缺失或重复文件');
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-tree-photo]')].filter(e => e.textContent.startsWith('P')).every(e => e.querySelector('span[title="/nav/相册"]')?.textContent === '相册')`), true, '平铺文件应显示相对项目目录副标题');
  } finally {
    await restoreFetch();
    await evaluate('delete window.__navigationLayoutRequests');
  }
  assert.deepEqual(await marks(), beforeLayout, '切换布局和加载分页不能修改标记');
  console.log('ok 全部文件隐藏子目录、递归相对目录副标题、205项独立普通/待删分页；布局不改位置/标记');

  await click(`[data-tree-photo="${last}"]`);
  await waitFor(`${current('P204')} && document.querySelector('[data-deck-card] img')?.alt === 'P204'`, '平铺跨页点击P204未走照片定位');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('dir')`), '/nav');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('sel')`), null);
  await click(`[data-tree-photo="${deleted}"]`);
  await waitFor(current('P205'), '平铺点击待删P205未定位');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('sel')`), 'del');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('photo')`), deleted);
  await reloadPage();
  await waitFor(`${layoutIs('全部文件')} && ${current('P205')} && document.querySelector('[data-tree-photo="${deleted}"][data-active="true"][aria-current="true"]')`, '刷新应保留平铺布局和待删P205位置/高亮');
  assert.equal(await evaluate(`document.querySelector('[data-folder-path="/nav/相册"]') === null`), true, '刷新平铺不能恢复子目录');
  const beforeTreePosition = await evaluate('location.href');
  await clickText('目录树');
  await waitFor(`${layoutIs('目录树')} && document.querySelector('[data-folder-toggle="/nav/相册"][aria-expanded="true"]') &&
    document.querySelector('[data-tree-photo="${deleted}"][data-active="true"]')`, '切回目录树应恢复目录展开和当前照片');
  assert.equal(await evaluate('location.href'), beforeTreePosition, '切回目录树不能改变导航位置');
  await waitFor(current('P205'), '切回目录树不能改变当前照片');
  assert.equal(await evaluate(`document.querySelector('[data-tree-photo="${deleted}"] span[title="/nav/相册"]') === null`), true, '目录树不应保留平铺副标题');
  assert.equal(await evaluate(`localStorage.getItem('artworks:sidebar-layout')`), 'tree');
  // The deck now shows the deleted stream, whose seen count differs from the normal stream.
  await expectProjectProgress('/nav', layoutSeen, 205);
  assert.deepEqual(await marks(), beforeLayout, '平铺定位、刷新和恢复目录树不能修改标记');
  console.log('ok 平铺点击P204/P205沿用普通/待删定位，刷新保留平铺，切回目录树恢复且位置/标记不变');

  await click('[aria-label="新建项目"]');
  await waitFor(`document.querySelector('[role="dialog"] input')`, '新建项目对话框未打开');
  const fillProject = async (path) => evaluate(`(() => {
    const inputs = document.querySelectorAll('[role="dialog"] input');
    if (inputs.length !== 2) throw new Error('新建项目应有名称和目录两个输入框');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    [${JSON.stringify('新建项目测试')}, ${JSON.stringify(path)}].forEach((value, i) => {
      setValue.call(inputs[i], value);
      inputs[i].dispatchEvent(new Event('input', { bubbles:true }));
    });
  })()`);
  await fillProject(`${addPath}/does-not-exist`);
  await clickText('创建项目');
  await waitFor(`document.querySelector('[role="dialog"] [role="alert"]')?.textContent.trim()`, '无效目录应保留对话框并显示错误');
  assert.equal(await evaluate(`document.querySelector('[role="dialog"]') !== null`), true, '创建失败不能关闭对话框');
  await fillProject(addPath);
  await clickText('创建项目');
  await waitFor(`!document.querySelector('[role="dialog"]')`, '创建成功未关闭对话框');
  await waitFor(current('NEWPROJECT'), '新建项目扫描后未自动进入唯一照片');
  assert.equal(await evaluate(`document.querySelector('[data-current-project]')?.textContent`), '项目：新建项目测试');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('view')`), 'cull');
  console.log('ok 新建项目：无效目录保留错误，修正后扫描并进入新项目挑片');

  const settingsUrl = await evaluate(`(() => {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ dir:'/nav', view:'settings', sel:'del', photo:${JSON.stringify(deleted)} }).toString();
    return url.href;
  })()`);
  await send('Page.navigate', { url: settingsUrl });
  await waitFor(`[...document.querySelectorAll('button[data-active="true"]')].some(e => e.textContent.trim() === '设置')`, '非挑片深链未进入设置页');
  // Settings renders before boot finishes; mode is added by URL sync once the listing is restored.
  await waitFor(`document.querySelector('[data-current-project]')?.textContent === '项目：导航测试' && new URLSearchParams(location.search).has('mode')`, '设置深链启动未完成项目恢复');
  await clickText('挑片');
  await waitFor(current('P205'), '从设置返回挑片未恢复深链指定的待删照片');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('dir')`), '/nav');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('sel')`), 'del');
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('photo')`), deleted);
  console.log('ok settings深链保留dir/sel/photo，点击挑片恢复待删P205');
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'artworks-nav-'));
  let server;
  try {
    const require = createRequire(join(REPO, 'server/package.json'));
    const sharp = require('sharp');
    const jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#829cba' } }).jpeg().toBuffer();
    const library = join(dir, 'lib');
    const album = join(library, '相册');
    const other = join(dir, 'other');
    const newProject = join(dir, 'new-project');
    await mkdir(album, { recursive: true });
    await mkdir(other);
    await mkdir(newProject);
    await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(join(album, `P${String(i + 1).padStart(3, '0')}.jpg`), jpeg)));
    await writeFile(join(other, 'OTHER.jpg'), jpeg);
    await writeFile(join(newProject, 'NEWPROJECT.jpg'), jpeg);
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ host: '127.0.0.1', port, password: '', dataDir: join(dir, 'data'),
      roots: [{ id: 'nav', label: '导航测试', path: library }, { id: 'other', label: '第二项目', path: other }] }));
    let log = '';
    server = spawn(process.execPath, ['src/index.ts', `--config=${config}`], {
      cwd: join(REPO, 'server'), env: { ...process.env, ARTWORKS_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', b => { log += b; });
    server.stderr.on('data', b => { log += b; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try {
        const data = await (await fetch(`${base}/api/v1/photos?dir=/nav&recursive=1&limit=1000`, { signal: AbortSignal.timeout(1000) })).json();
        if (data.total === 205) { ready = true; break; }
      } catch { /* 等启动/扫描 */ }
      await sleep(100);
    }
    assert.ok(ready, `独立库未就绪\n${log}`);
    const photos = await (await fetch(`${base}/api/v1/photos?dir=/nav&recursive=1&limit=1000`)).json();
    const deleted = photos.items.find(p => p.displayName === 'P205');
    const marked = await fetch(`${base}/api/v1/marks`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: deleted.id, del: true }] }) });
    assert.ok(marked.ok);
    const browser = spawn(process.execPath, [SHOT, '--url', `${base}/?dir=/other&testAddPath=${encodeURIComponent(newProject)}`, '--out', '/tmp/artworks-nav-regression.png', '--width', '1440', '--height', '900', '--dsf', '1', '--wait', '1500', '--script', FILE], { stdio: 'inherit' });
    const [code] = await once(browser, 'exit');
    assert.equal(code, 0, '浏览器导航回归失败');
    const remaining = await (await fetch(`${base}/api/v1/photos?dir=/nav&recursive=1&sel=del`)).json();
    assert.equal(remaining.items[0]?.id, deleted.id, '定位待删不应改动其标记');
    console.log('PASS 项目树导航回归（真实鼠标点击；临时库已隔离）');
  } finally {
    if (server?.exitCode === null) {
      const stopped = once(server, 'exit');
      server.kill('SIGTERM');
      await Promise.race([stopped, sleep(3000)]);
      if (server.exitCode === null) { server.kill('SIGKILL'); await stopped; }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === FILE) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
