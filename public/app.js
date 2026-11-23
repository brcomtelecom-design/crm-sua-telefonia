const state = { csrfToken: '', user: null, conversations: [], selectedConversation: null, installations: [] };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 4200);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (state.csrfToken && options.method && !['GET', 'HEAD'].includes(options.method)) headers.set('X-CSRF-Token', state.csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Falha HTTP ${response.status}`);
    error.code = data?.error?.code;
    error.status = response.status;
    error.details = data?.error?.details;
    throw error;
  }
  return data;
}

function setLoggedIn(loggedIn) {
  $('#login-view').hidden = loggedIn;
  $('#app-view').hidden = !loggedIn;
}

function applyPermissions() {
  const admin = state.user?.role === 'admin';
  for (const selector of ['#qr-form', '#tenant-form', '#waba-form', '#installation-form']) {
    const section = $(selector)?.closest('details');
    if (section) section.hidden = !admin;
  }
}

function switchView(name) {
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  const titles = { atendimento: 'Atendimento', campanhas: 'Campanhas', conexoes: 'Conexões' };
  $('#view-title').textContent = titles[name];
}

async function bootstrapSession() {
  try {
    const session = await api('/api/session');
    if (!session.user) {
      setLoggedIn(false);
      return;
    }
    state.csrfToken = session.csrfToken;
    state.user = session.user;
    applyPermissions();
    $('#user-email').textContent = session.user.email;
    setLoggedIn(true);
    await Promise.all([loadConversations(), loadAccounts(), loadInstallations(), loadCampaigns()]);
  } catch {
    setLoggedIn(false);
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    const session = await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ email: $('#login-email').value, password: $('#login-password').value }),
    });
    state.csrfToken = session.csrfToken;
    state.user = session.user;
    applyPermissions();
    $('#user-email').textContent = session.user.email;
    setLoggedIn(true);
    await Promise.all([loadConversations(), loadAccounts(), loadInstallations(), loadCampaigns()]);
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/session', { method: 'DELETE' }); } finally { setLoggedIn(false); state.csrfToken = ''; }
});

$$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));

async function loadConversations() {
  const result = await api('/api/conversations?limit=100');
  state.conversations = result.items;
  const container = $('#conversation-items');
  container.replaceChildren();
  if (!result.items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Nenhuma conversa recebida.';
    container.append(empty);
    return;
  }
  for (const conversation of result.items) {
    const button = document.createElement('button');
    button.className = `list-item${state.selectedConversation?.id === conversation.id ? ' active' : ''}`;
    const title = document.createElement('strong');
    title.textContent = conversation.customerName || conversation.remoteId;
    const preview = document.createElement('span');
    preview.textContent = conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleString('pt-BR') : conversation.remoteId;
    button.append(title, preview);
    button.addEventListener('click', () => selectConversation(conversation));
    container.append(button);
  }
}

async function selectConversation(conversation) {
  state.selectedConversation = conversation;
  const result = await api(`/api/conversations/${encodeURIComponent(conversation.id)}/messages?limit=100`);
  $('#chat-empty').hidden = true;
  $('#chat-content').hidden = false;
  $('#chat-title').textContent = conversation.customerName || conversation.remoteId;
  $('#chat-channel').textContent = conversation.remoteId;
  const container = $('#message-items');
  container.replaceChildren();
  for (const message of result.items.reverse()) {
    const element = document.createElement('div');
    element.className = `message ${message.direction}`;
    const body = document.createElement('div');
    body.textContent = message.body;
    const meta = document.createElement('small');
    meta.textContent = `${new Date(message.createdAt).toLocaleString('pt-BR')} · ${message.status}`;
    element.append(body, meta);
    container.append(element);
  }
  await loadConversations();
}

$('#refresh-conversations').addEventListener('click', () => void loadConversations());

$('#reply-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selectedConversation) return;
  const button = event.submitter;
  button.disabled = true;
  try {
    const body = $('#reply-body').value.trim();
    const idempotencyKey = crypto.randomUUID();
    await api(`/api/conversations/${encodeURIComponent(state.selectedConversation.id)}/messages`, {
      method: 'POST', body: JSON.stringify({ body, idempotencyKey }),
    });
    $('#reply-body').value = '';
    await selectConversation(state.selectedConversation);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

async function loadAccounts() {
  const result = await api('/api/accounts');
  const container = $('#account-items');
  container.replaceChildren();
  const accountSelect = $('#campaign-account');
  const previousAccount = accountSelect.value;
  accountSelect.replaceChildren(new Option('Selecione', ''));
  for (const account of result.items.filter((item) => item.kind === 'waba' && item.status === 'active')) {
    accountSelect.add(new Option(account.name, account.id));
  }
  if (previousAccount && [...accountSelect.options].some((option) => option.value === previousAccount)) {
    accountSelect.value = previousAccount;
  }
  const connected = result.items.filter((account) => account.status === 'active' || account.status === 'connected').length;
  const pending = result.items.filter((account) => account.status === 'pending' || account.status === 'inactive' || account.status === 'connecting').length;
  const badge = $('#connection-state');
  if (!result.items.length) badge.className = 'state-pill offline';
  else if (connected) badge.className = 'state-pill online';
  else if (pending) badge.className = 'state-pill pending';
  else badge.className = 'state-pill offline';
  badge.textContent = connected ? `${connected} canal(is) ativo(s)` : pending ? `${pending} conexão(ões) pendente(s)` : 'Canais offline';
  for (const account of result.items) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const title = document.createElement('strong');
    title.textContent = account.name;
    const detail = document.createElement('span');
    detail.textContent = `${account.kind.toUpperCase()} · ${account.status}${account.lastError ? ` · ${account.lastError}` : ''}`;
    item.append(title, detail);
    if (account.kind === 'waba' && account.status === 'inactive' && state.user?.role === 'admin') {
      const activate = document.createElement('button');
      activate.className = 'secondary';
      activate.type = 'button';
      activate.textContent = 'Ativar';
      activate.addEventListener('click', async () => {
        try {
          await api(`/api/waba-accounts/${encodeURIComponent(account.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
          await loadAccounts();
          toast('Conta WABA ativada no CRM.');
        } catch (error) { toast(error.message); }
      });
      item.append(activate);
    }
    if (account.kind === 'qr' && state.user?.role === 'admin') {
      const controls = document.createElement('div');
      controls.className = 'inline-actions';
      const connect = document.createElement('button');
      connect.className = 'secondary';
      connect.type = 'button';
      connect.textContent = 'Conectar';
      connect.addEventListener('click', async () => {
        try {
          await api(`/api/qr-accounts/${encodeURIComponent(account.id)}/connect`, { method: 'POST' });
          await loadAccounts();
          toast('Solicitação de conexão QR processada.');
        } catch (error) { toast(error.message); }
      });
      const showQr = document.createElement('button');
      showQr.className = 'secondary';
      showQr.type = 'button';
      showQr.textContent = 'Exibir QR';
      showQr.addEventListener('click', async () => {
        try {
          const result = await api(`/api/qr-accounts/${encodeURIComponent(account.id)}/qr`);
          const image = document.querySelector(`[data-qr-image="${CSS.escape(account.id)}"]`);
          if (!result.qr || !image) {
            toast('O QR ainda não está disponível.');
            return;
          }
          image.src = result.qr;
          image.hidden = false;
        } catch (error) { toast(error.message); }
      });
      const image = document.createElement('img');
      image.className = 'qr-image';
      image.alt = `QR de pareamento de ${account.name}`;
      image.dataset.qrImage = account.id;
      image.hidden = true;
      controls.append(connect, showQr);
      item.append(controls, image);
    }
    container.append(item);
  }
}

$('#qr-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#qr-error').textContent = '';
  try {
    await api('/api/qr-accounts', {
      method: 'POST',
      body: JSON.stringify({ name: $('#qr-name').value }),
    });
    $('#qr-form').reset();
    await loadAccounts();
    toast('Conta QR criada. Use “Conectar” somente quando o QR estiver habilitado no servidor.');
  } catch (error) { $('#qr-error').textContent = error.message; }
});

$('#tenant-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#tenant-error').textContent = '';
  try {
    await api('/api/admin/tenants', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#tenant-name').value,
        email: $('#tenant-email').value,
        password: $('#tenant-password').value,
        role: 'admin',
      }),
    });
    $('#tenant-form').reset();
    toast('Empresa e administrador cadastrados.');
  } catch (error) { $('#tenant-error').textContent = error.message; }
});

$('#waba-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#waba-error').textContent = '';
  try {
    await api('/api/waba-accounts', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#waba-name').value,
        externalId: $('#waba-phone-id').value,
        wabaId: $('#waba-id').value,
        accessToken: $('#waba-token').value,
        appSecret: $('#waba-secret').value,
      }),
    });
    $('#waba-form').reset();
    await loadAccounts();
    toast('Conta cadastrada. Ative-a somente após revisar as credenciais.');
  } catch (error) { $('#waba-error').textContent = error.message; }
});

async function loadInstallations() {
  const result = await api('/api/installations');
  state.installations = result.items;
  const select = $('#campaign-installation');
  select.replaceChildren(new Option('Selecione', ''));
  for (const installation of result.items.filter((item) => item.active)) select.add(new Option(installation.name, installation.id));
  const container = $('#installation-items');
  container.replaceChildren();
  for (const installation of result.items) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const title = document.createElement('strong');
    title.textContent = installation.name;
    const detail = document.createElement('span');
    detail.textContent = `${installation.active ? 'Ativa' : 'Revogada'} · ${installation.lastSeenAt ? `último contato ${new Date(installation.lastSeenAt).toLocaleString('pt-BR')}` : 'offline'}`;
    item.append(title, detail);
    container.append(item);
  }
}

$('#installation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/installations', {
      method: 'POST', body: JSON.stringify({ name: $('#installation-name').value }),
    });
    const output = $('#installation-token');
    output.textContent = result.installation.token;
    output.hidden = false;
    $('#installation-name').value = '';
    await loadInstallations();
    toast('Token gerado. Copie e guarde em local seguro.');
  } catch (error) { toast(error.message); }
});

async function loadCampaigns() {
  const result = await api('/api/campaigns');
  const container = $('#campaign-items');
  container.replaceChildren();
  for (const campaign of result.items) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const title = document.createElement('strong');
    title.textContent = campaign.name;
    const detail = document.createElement('span');
    detail.textContent = `${campaign.executor === 'local' ? 'Executor local' : 'Executor Web'} · ${campaign.status} · ${campaign.sent}/${campaign.audienceCount} enviados · ${campaign.pending} pendentes · ${campaign.attention} atenção`;
    item.append(title, detail);
    if (campaign.executor === 'web' && !['completed', 'cancelled'].includes(campaign.status)) {
      const controls = document.createElement('div');
      controls.className = 'inline-actions';
      if (campaign.status !== 'running') {
        const start = document.createElement('button');
        start.className = 'secondary'; start.type = 'button'; start.textContent = 'Iniciar';
        start.addEventListener('click', () => void campaignAction(campaign.id, 'start'));
        controls.append(start);
      }
      if (campaign.status !== 'paused') {
        const pause = document.createElement('button');
        pause.className = 'secondary'; pause.type = 'button'; pause.textContent = 'Pausar';
        pause.addEventListener('click', () => void campaignAction(campaign.id, 'pause'));
        controls.append(pause);
      }
      const cancel = document.createElement('button');
      cancel.className = 'secondary'; cancel.type = 'button'; cancel.textContent = 'Cancelar';
      cancel.addEventListener('click', () => void campaignAction(campaign.id, 'cancel'));
      controls.append(cancel);
      item.append(controls);
    }
    container.append(item);
  }
}

async function campaignAction(id, action) {
  try {
    await api(`/api/campaigns/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    await loadCampaigns();
  } catch (error) { toast(error.message); }
}

function syncCampaignExecutorFields() {
  const local = $('#campaign-executor').value === 'local';
  $('#campaign-installation').disabled = !local;
  $('#campaign-account').disabled = local;
  if (local) $('#campaign-installation').closest('label').classList.add('muted');
  else $('#campaign-account').closest('label').classList.remove('muted');
}

$('#campaign-executor').addEventListener('change', syncCampaignExecutorFields);
syncCampaignExecutorFields();

$('#campaign-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#campaign-error').textContent = '';
  const file = $('#campaign-file').files[0];
  if (!file) return;
  const executor = $('#campaign-executor').value;
  if (executor === 'web' && !$('#campaign-account').value) {
    $('#campaign-error').textContent = 'Ative e selecione uma conta WABA para o executor Web.';
    return;
  }
  if (executor === 'local' && !$('#campaign-installation').value) {
    $('#campaign-error').textContent = 'Selecione a instalação local ou use o executor Web.';
    return;
  }
  let parameters = [];
  const parameterText = $('#campaign-parameters').value.trim();
  if (parameterText) {
    try {
      parameters = JSON.parse(parameterText);
      if (!Array.isArray(parameters)) throw new Error('use uma lista JSON');
    } catch {
      $('#campaign-error').textContent = 'Os parâmetros do modelo devem ser uma lista JSON válida.';
      return;
    }
  }
  const button = event.submitter;
  button.disabled = true;
  try {
    const bytes = await file.arrayBuffer();
    const upload = await api(`/api/campaigns/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    const campaign = await api('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        uploadId: upload.upload.id,
        accountId: executor === 'web' ? $('#campaign-account').value : null,
        name: $('#campaign-name').value,
        templateName: $('#campaign-template').value,
        parameters,
        executor,
        installationId: executor === 'local' ? $('#campaign-installation').value : null,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const summary = $('#campaign-summary');
    summary.textContent = `Upload processado: ${upload.upload.rowCount} destinatários, ${upload.upload.cellCount} células. Campanha ${campaign.campaign.status}.`;
    summary.hidden = false;
    $('#campaign-form').reset();
    syncCampaignExecutorFields();
    await loadCampaigns();
  } catch (error) {
    $('#campaign-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

bootstrapSession();

async function refreshActiveViews() {
  if (!$('#app-view').hidden && !document.hidden) {
    try {
      await Promise.all([loadConversations(), loadCampaigns()]);
    } catch (error) {
      console.warn('Falha ao atualizar dados periódicos.', error);
    }
  }
  setTimeout(refreshActiveViews, document.hidden ? 15000 : 5000);
}

setTimeout(refreshActiveViews, 5000);
