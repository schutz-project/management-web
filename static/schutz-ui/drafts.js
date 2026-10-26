/* Evidence-based drafts. Reading and filling only: never save or close an incident. */
(function (root) {
  'use strict';
  const recoveryMessages = {
    TWO_HEALTHY_CHECKS_REQUIRED: '정상 점검 2회 연속 확인이 필요합니다.',
    CHECK_COLLECTION_STALE: '최근 점검 데이터 갱신이 필요합니다.',
    PROMETHEUS_RECOVERY_NOT_CONFIRMED: '최신 Prometheus 평가와 정상 지표 확인이 필요합니다.',
    DELIVERY_SUCCESS_REQUIRED: '최초 Slack·AI 분석·AI 완료 Slack의 실제 처리 성공 확인이 필요합니다.',
    LOG_COLLECTION_STALE: '최근 로그인 로그 수집 확인이 필요합니다.',
    FAILURE_FREE_WINDOW_REQUIRED: '추가 로그인 실패 없이 60초가 경과해야 합니다.'
  };
  const rules = {
    availability_failure: '가용성 실패', response_delay: '응답 지연',
    login_failures: '반복 로그인 실패', notification_delivery_test: '알림 전달 시험',
    monitoring_target_down: '수집 대상 연결 실패', portal_telemetry_missing: '앱 메트릭 누락',
    portal_high_error_rate: '5xx 비율 증가'
  };
  const stateNames = {pending: '대기', running: '실행 중', failed: '실패'};
  const bounded = value => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80);

  function jobText(jobs, kind, label) {
    const job = jobs.find(j => j.kind === kind);
    if (!job) return label + ' 작업 이력이 없습니다.';
    if (job.mode === 'demo') return label + '은 데모 모드로 처리되어 실제 외부 연동은 확인되지 않았습니다.';
    if (job.mode === 'live' && job.status === 'succeeded') {
      if (kind === 'ai') return '실제 AI 분석 작업의 완료 기록을 확인했습니다.';
      if (job.result && job.result.sent === true) return label + '의 Slack 전송 성공 기록을 확인했습니다.';
      return label + ' 작업은 완료됐지만 실제 Slack 전송 성공은 확인되지 않았습니다.';
    }
    return label + '은 ' + (stateNames[job.status] || '확인 필요') + ' 상태입니다.';
  }

  function buildDraft(data) {
    if (!data || typeof data.id !== 'string' || !Array.isArray(data.jobs) ||
        !data.closure || !Array.isArray(data.closure.reasons) ||
        typeof data.closure.eligible !== 'boolean') {
      throw new Error('사건 상세 응답을 확인할 수 없습니다. 새로고침 후 다시 시도해주세요.');
    }
    const blockers = data.closure.reasons.filter(r => !['ACTION_REQUIRED', 'TEST_STOP_REQUIRED'].includes(r));
    // A closed incident has no current closure checks; never infer its current recovery.
    const recovered = data.status !== 'closed' && blockers.length === 0;
    const security = data.rule_id === 'login_failures';
    const title = (data.synthetic ? '[모의] ' : '') + bounded(data.target_id) + ' ' +
      (rules[data.rule_id] || '이상 탐지') + ' 사건';
    let recovery;
    if (data.status === 'closed') recovery = '종료된 사건입니다. 현재 복구 상태는 별도 점검이 필요합니다.';
    else if (!recovered) recovery = '복구 조건이 아직 충족되지 않았습니다. ' + blockers.map(r => recoveryMessages[r] || '추가 복구 조건 확인이 필요합니다.').join(' ');
    else if (data.rule_id === 'notification_delivery_test' && data.synthetic) recovery = '모의 알림 전달 시험의 처리 성공 조건을 확인했습니다. 실제 장애 복구를 의미하지 않으며 시험 종료와 알림 수신은 담당자가 확인해야 합니다.';
    else if (data.monitoring) recovery = '현재 사건의 Prometheus 복구 조건을 확인했습니다. 사건 종료는 담당자의 조치 기록과 확인이 필요합니다.';
    else if (security) recovery = '로그 수집 갱신과 추가 로그인 실패 없이 60초 경과 조건을 확인했습니다. 시험 입력 중지 여부는 담당자의 확인이 필요합니다.';
    else recovery = '정상 점검 2회 이상 연속 및 최근 점검 데이터 갱신 조건 충족을 확인했습니다.';
    const delivery = [jobText(data.jobs, 'slack', '최초 알림'), jobText(data.jobs, 'ai', 'AI 분석'), jobText(data.jobs, 'slack_ai', 'AI 후속 알림')].join(' ');
    const ready = recovered && data.status === 'in_progress' && data.closure.eligible;
    return {
      action: (title + '의 모니터링 결과를 검토했습니다. ' + recovery + ' ' + delivery).slice(0, 1000),
      resolution: (ready
        ? title + '의 복구 조건과 저장된 조치 기록을 검토했습니다. ' + recovery + ' ' + delivery + ' 위 근거를 검토하여 사건을 종료합니다.'
        : '종료 조건이 아직 충족되지 않아 종료 근거를 확정할 수 없습니다. ' + recovery).slice(0, 1000),
      recovered, ready,
      note: '조회 시점의 이력으로 만든 초안입니다. 실제 수행한 조치를 확인·보완해주세요. Slack 전송 성공은 사람의 수신 확인을 의미하지 않습니다.'
    };
  }

  function attach(data, apiRequest) {
    const doc = root.document;
    if (!doc || data.status === 'closed') return;
    for (const [id, kind, label] of [
      ['action-content', 'action', '조치 초안 자동 작성'],
      ['resolution', 'resolution', '종료 근거 초안 자동 작성']
    ]) {
      const input = doc.getElementById(id);
      if (!input || input.form.querySelector('[data-draft-kind="' + kind + '"]')) continue;
      const panel = doc.createElement('div');
      panel.dataset.draftKind = kind;
      panel.className = 'draft-panel';

      const generate = doc.createElement('button');
      generate.type = 'button'; generate.textContent = label;
      const note = doc.createElement('p');
      note.className = 'muted'; note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
      note.textContent = '최신 이력을 조회해 빈 입력칸에 초안을 채웁니다. 저장과 사건 종료는 직접 확인 후 진행해주세요.';
      const preview = doc.createElement('textarea');
      preview.readOnly = true; preview.rows = 6; preview.hidden = true;
      preview.setAttribute('aria-label', '자동 작성된 초안 미리보기');
      const apply = doc.createElement('button');
      apply.type = 'button'; apply.textContent = '이 초안을 입력칸에 넣기'; apply.hidden = true;
      let generatedAt = 0, generatedNote = '';
      function fill() {
        if (Date.now() - generatedAt > 60000) {
          note.textContent = '초안 조회 후 60초가 지났습니다. 자동 작성 버튼으로 최신 이력을 다시 확인해주세요.';
          apply.disabled = true; return;
        }
        input.value = preview.value;
        input.dispatchEvent(new root.Event('input', {bubbles: true}));
        note.textContent = generatedNote + ' 초안을 입력했습니다. 내용을 검토한 뒤 저장해주세요. 자동 저장하거나 사건을 종료하지 않습니다.';
        input.focus();
      }
      apply.onclick = fill;
      generate.onclick = async () => {
        generate.disabled = true; apply.disabled = true;
        note.textContent = '최신 사건 이력을 조회하고 있습니다…';
        try {
          const fresh = await apiRequest('/api/incidents/' + encodeURIComponent(data.id));
          if (!input.isConnected) return;
          if (fresh.id !== data.id || !['accepted', 'in_progress'].includes(fresh.status)) {
            throw new Error('사건 상태가 변경됐습니다. 화면을 새로고침해주세요.');
          }
          const draft = buildDraft(fresh);
          generatedAt = Date.now(); generatedNote = draft.note; preview.value = draft[kind]; preview.hidden = false;
          apply.hidden = false; apply.disabled = kind === 'resolution' && !draft.ready;
          note.textContent = draft.note;
          if (apply.disabled) note.textContent += ' 종료 조건을 먼저 충족해주세요.';
          else if (!input.value.trim()) fill();
          else note.textContent += ' 기존 입력 내용은 유지했습니다. 미리보기를 검토한 뒤 입력 버튼을 누르면 교체됩니다.';
        } catch (error) {
          if (input.isConnected) note.textContent = error.message || '초안을 가져오지 못했습니다. 기존 입력 내용은 유지됩니다.';
        } finally { generate.disabled = false; }
      };
      panel.append(generate, note, preview, apply);
      input.form.insertBefore(panel, input);
    }
  }
  root.SchutzDrafts = {buildDraft, attach};
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SchutzDrafts;
})(typeof window !== 'undefined' ? window : globalThis);


